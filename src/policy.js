// @ts-check
// Spending limits. Every payment passes two gates: the buyer policy the paying
// fetch asserts before it pays (right seller, amount under the per-payment
// cap), and the guard the payer runs the payment through (daily cap, counted
// together with payments still in flight, and a pause after a payment whose
// outcome is unknown).

import { PolicyError } from "./errors.js";
import { formatSat, localDayStart } from "./util.js";

/**
 * @typedef {import("./store.js").Ledger} Ledger
 */

export class SpendGuard {
	/**
	 * @param {{
	 *   maxSatsPerPayment: number,
	 *   maxSatsPerDay: number,
	 *   ledger: Ledger,
	 *   now?: () => number,
	 * }} options
	 */
	constructor(options) {
		this.maxSatsPerPayment = options.maxSatsPerPayment;
		this.maxSatsPerDay = options.maxSatsPerDay;
		this.ledger = options.ledger;
		this.now = options.now ?? Date.now;
		this.inFlight = 0;
		this.pausedUntil = 0;
	}

	/** spentToday is what payments made since local midnight cost. */
	spentToday() {
		return this.ledger.spentSince(localDayStart(this.now()));
	}

	/**
	 * check throws a PolicyError if a payment of amountSat may not be made now.
	 *
	 * @param {number} amountSat
	 */
	check(amountSat) {
		if (!Number.isFinite(amountSat) || amountSat <= 0) {
			throw new PolicyError("the seller asked for a payment with no amount", "invalid_amount");
		}
		if (amountSat > this.maxSatsPerPayment) {
			throw new PolicyError(
				`this bundle costs ${formatSat(amountSat)} sats, above the limit of ${formatSat(this.maxSatsPerPayment)} sats per payment. ` +
					`Restart l402-bridge with --max-sats-per-payment ${amountSat} to allow it, or pick a cheaper model.`,
				"over_payment_limit",
			);
		}
		const committed = this.spentToday() + this.inFlight;
		if (committed + amountSat > this.maxSatsPerDay) {
			throw new PolicyError(
				`paying ${formatSat(amountSat)} sats would pass today's limit of ${formatSat(this.maxSatsPerDay)} sats ` +
					`(${formatSat(committed)} already spent or in flight). Raise it with --max-sats-per-day.`,
				"over_daily_limit",
			);
		}
		const pause = this.pausedUntil - this.now();
		if (pause > 0) {
			throw new PolicyError(
				`a recent payment's outcome is unknown, so payments are paused for ${Math.ceil(pause / 1000)} more seconds. ` +
					"Check your wallet's history before retrying.",
				"paused",
			);
		}
	}

	/**
	 * run makes one payment under the limits: it checks, reserves the amount
	 * while fn runs, and releases the reservation afterwards. The payer
	 * records the payment in the ledger as soon as money has moved, so the
	 * reservation never needs to outlive fn.
	 *
	 * @template T
	 * @param {number} amountSat
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	async run(amountSat, fn) {
		this.check(amountSat);
		this.inFlight += amountSat;
		try {
			return await fn();
		} finally {
			this.inFlight -= amountSat;
		}
	}

	/**
	 * pause stops new payments for a while, after a payment whose outcome the
	 * wallet could not confirm.
	 *
	 * @param {number} ms
	 */
	pause(ms) {
		this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
	}
}

/**
 * sellerPolicy is the BuyerPolicy for the paying fetch: pay only the
 * configured seller, and only amounts the guard would allow.
 *
 * @param {{ sellerOrigin: string, guard: SpendGuard }} options
 * @returns {import("@lightninglabs/aperture-core").BuyerPolicy}
 */
export function sellerPolicy({ sellerOrigin, guard }) {
	return {
		async assertAllowed({ url, amountSat }) {
			let origin;
			try {
				origin = new URL(url).origin;
			} catch {
				origin = "";
			}
			if (origin !== sellerOrigin) {
				throw new PolicyError(`refusing to pay ${origin || url}: it is not the configured seller`, "wrong_seller");
			}
			guard.check(amountSat);
		},
	};
}
