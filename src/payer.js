// @ts-check
// The wallet side: an InvoicePayer for @lightninglabs/aperture-client that
// pays over Nostr Wallet Connect (NIP-47), so any NWC wallet can fund the
// bridge: Alby Hub, Primal, Coinos, Zeus, Rizful and others.
//
// A payment is checked before it goes out (the invoice amount must match the
// quote, and the spend guard must allow it) and after (the preimage must hash
// to the invoice's payment hash). A payment the wallet reports neither paid
// nor failed, such as a reply that never arrives, is looked up by payment
// hash before anything else happens, so a timeout cannot turn into a second
// payment.

import { AsyncLocalStorage } from "node:async_hooks";
import {
	Nip47PublishError,
	Nip47PublishTimeoutError,
	Nip47UnsupportedEncryptionError,
	Nip47WalletError,
} from "@getalby/sdk/nwc";
import { WalletError } from "./errors.js";
import { decodeInvoice, sha256Hex } from "./util.js";

/**
 * paymentContext carries the request a payment is made for (the model and
 * the seller) from the server to the payer, through the paying fetch.
 *
 * @type {AsyncLocalStorage<{ model: string, seller: string }>}
 */
export const paymentContext = new AsyncLocalStorage();

// Wallet error codes after which the payment did not happen. INTERNAL and
// OTHER are left out: they say something went wrong, not that no money moved.
const DEFINITE_FAILURES = new Set([
	"RATE_LIMITED",
	"NOT_IMPLEMENTED",
	"INSUFFICIENT_BALANCE",
	"QUOTA_EXCEEDED",
	"RESTRICTED",
	"UNAUTHORIZED",
	"PAYMENT_FAILED",
	"NOT_FOUND",
]);

/**
 * isDefiniteFailure reports whether a pay_invoice error means the wallet did
 * not pay. Everything else is treated as an unknown outcome.
 *
 * @param {unknown} err
 */
function isDefiniteFailure(err) {
	if (err instanceof Nip47PublishTimeoutError) {
		// The request may have reached a relay and the wallet.
		return false;
	}
	if (err instanceof Nip47PublishError || err instanceof Nip47UnsupportedEncryptionError) {
		// No relay took the request, or it could not be encrypted.
		return true;
	}
	return err instanceof Nip47WalletError && DEFINITE_FAILURES.has(err.code);
}

/**
 * describe turns a wallet error into a short message for the user.
 *
 * @param {unknown} err
 */
function describe(err) {
	if (err instanceof Nip47WalletError) {
		switch (err.code) {
			case "INSUFFICIENT_BALANCE":
				return "the wallet does not have enough sats";
			case "QUOTA_EXCEEDED":
				return "the wallet connection's budget is used up (raise it in your wallet's app connection settings)";
			case "RESTRICTED":
			case "UNAUTHORIZED":
				return "the wallet connection is not allowed to pay invoices";
			default:
				return `the wallet refused the payment (${err.code}: ${err.message})`;
		}
	}
	return err instanceof Error ? err.message : String(err);
}

/**
 * @typedef {{
 *   payInvoice(request: { invoice: string }): Promise<{ preimage: string, fees_paid: number }>,
 *   lookupInvoice(request: { payment_hash: string }): Promise<{ state?: string, preimage?: string, fees_paid?: number }>,
 * }} NwcLike
 */

export class NwcPayer {
	/**
	 * @param {{
	 *   client: NwcLike,
	 *   guard: import("./policy.js").SpendGuard,
	 *   ledger: import("./store.js").Ledger,
	 *   onPaid?: (payment: import("./store.js").Payment) => void,
	 *   settleTimeoutMs?: number,
	 *   pollMs?: number,
	 *   pauseMs?: number,
	 *   sleep?: (ms: number) => Promise<void>,
	 * }} options
	 */
	constructor(options) {
		this.client = options.client;
		this.guard = options.guard;
		this.ledger = options.ledger;
		this.onPaid = options.onPaid;
		this.settleTimeoutMs = options.settleTimeoutMs ?? 90_000;
		this.pollMs = options.pollMs ?? 3_000;
		this.pauseMs = options.pauseMs ?? 120_000;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/**
	 * payInvoice pays one challenge's invoice and returns its preimage.
	 *
	 * @param {{ invoice: string, amountSat: number, challengeId: string }} input
	 * @returns {Promise<{ preimageHex: string, amountPaidSat: number }>}
	 */
	async payInvoice({ invoice, amountSat }) {
		let decoded;
		try {
			decoded = decodeInvoice(invoice);
		} catch (err) {
			throw new WalletError(`the seller's invoice could not be read: ${describe(err)}`, { cause: err });
		}
		if (decoded.amountSat === null || decoded.amountSat !== amountSat) {
			throw new WalletError(
				`the seller's invoice asks for ${decoded.amountSat ?? "no"} sats, not the ${amountSat} sats it quoted`,
			);
		}

		return this.guard.run(amountSat, async () => {
			const result = await this.pay(invoice, decoded.paymentHash);
			const preimage = String(result.preimage ?? "").toLowerCase();
			const preimageOk = /^[0-9a-f]{64}$/.test(preimage) && sha256Hex(preimage) === decoded.paymentHash;
			const feesSat = Math.ceil((Number(result.fees_paid) || 0) / 1000);

			// The money moved: record it before anything can fail, so it
			// counts against the daily limit whatever happens next.
			const context = paymentContext.getStore();
			/** @type {import("./store.js").Payment} */
			const payment = {
				ts: new Date().toISOString(),
				seller: context?.seller ?? "",
				model: context?.model ?? "",
				amountSat,
				feesSat,
				paymentHash: decoded.paymentHash,
				preimageHex: preimageOk ? preimage : "",
				preimageOk,
			};
			this.ledger.append(payment);
			this.onPaid?.(payment);

			if (!preimageOk) {
				throw new WalletError(
					"the wallet reported the payment as made but returned a preimage that does not match the invoice",
				);
			}
			return { preimageHex: preimage, amountPaidSat: amountSat + feesSat };
		});
	}

	/**
	 * pay sends the invoice and resolves to the wallet's answer. An unknown
	 * outcome is settled by looking the payment up.
	 *
	 * @param {string} invoice
	 * @param {string} paymentHash
	 */
	async pay(invoice, paymentHash) {
		try {
			return await this.client.payInvoice({ invoice });
		} catch (err) {
			if (isDefiniteFailure(err)) {
				throw new WalletError(describe(err), { cause: err });
			}
			return this.settle(paymentHash, err);
		}
	}

	/**
	 * settle polls lookup_invoice until the payment is settled or failed. If
	 * that cannot be learned in time, payments pause and the error says the
	 * outcome is unknown.
	 *
	 * @param {string} paymentHash
	 * @param {unknown} cause
	 */
	async settle(paymentHash, cause) {
		const deadline = Date.now() + this.settleTimeoutMs;
		/** @type {unknown} */
		let lastError = cause;
		while (Date.now() < deadline) {
			try {
				const tx = await this.client.lookupInvoice({ payment_hash: paymentHash });
				if (tx.state === "settled" && tx.preimage) {
					return { preimage: tx.preimage, fees_paid: tx.fees_paid ?? 0 };
				}
				if (tx.state === "failed") {
					throw new WalletError(`the payment failed: ${describe(cause)}`, { cause });
				}
			} catch (err) {
				if (err instanceof WalletError) {
					throw err;
				}
				if (err instanceof Nip47WalletError && (err.code === "NOT_IMPLEMENTED" || err.code === "RESTRICTED")) {
					// The wallet cannot be asked; stop polling.
					lastError = err;
					break;
				}
				// NOT_FOUND right after a send, or a transient error: retry.
				lastError = err;
			}
			await this.sleep(this.pollMs);
		}
		this.guard.pause(this.pauseMs);
		throw new WalletError(
			`the wallet did not confirm whether the payment went through (${describe(lastError)}). ` +
				`Payments are paused for ${Math.round(this.pauseMs / 1000)} seconds; check your wallet's history before retrying.`,
			{ uncertain: true, cause },
		);
	}
}
