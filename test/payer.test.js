// @ts-check
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PolicyError, WalletError } from "../src/errors.js";
import { NwcPayer } from "../src/payer.js";
import { SpendGuard, sellerPolicy } from "../src/policy.js";
import { Ledger } from "../src/store.js";
import { decodeInvoice } from "../src/util.js";
import { fakeWallet, invoiceFor } from "./helpers.js";

function fixture() {
	const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "l402-payer-")), "payments.ndjson"));
	const guard = new SpendGuard({ maxSatsPerPayment: 2_000, maxSatsPerDay: 5_000, ledger });
	const preimage = randomBytes(32).toString("hex");
	const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
	const wallet = fakeWallet(new Map([[hash, preimage]]));
	const payer = new NwcPayer({ client: wallet, guard, ledger, settleTimeoutMs: 50, pollMs: 5 });
	return { ledger, guard, wallet, payer, preimage, hash };
}

test("decodeInvoice reads the payment hash and rounds msat amounts up", () => {
	const hash = "ab".repeat(32);
	assert.deepEqual(decodeInvoice(invoiceFor(1_500, hash)), { paymentHash: hash, amountSat: 1_500 });
	assert.throws(() => decodeInvoice("lnbc1nonsense"));
});

test("the payer pays a matching invoice and returns a verified preimage", async () => {
	const { payer, preimage, hash, ledger } = fixture();
	const result = await payer.payInvoice({ invoice: invoiceFor(1_000, hash), amountSat: 1_000, challengeId: "c" });
	assert.deepEqual(result, { preimageHex: preimage, amountPaidSat: 1_000 });
	assert.equal(ledger.payments.length, 1);
});

test("the payer refuses an invoice whose amount differs from the quote", async () => {
	const { payer, hash, wallet } = fixture();
	await assert.rejects(
		payer.payInvoice({ invoice: invoiceFor(1_999, hash), amountSat: 1_000, challengeId: "c" }),
		(err) => err instanceof WalletError && /asks for 1999 sats, not the 1000/.test(err.message),
	);
	assert.equal(wallet.paid.length, 0);
});

test("the guard's limits apply to the payer too", async () => {
	const { payer, hash, wallet, guard } = fixture();
	await assert.rejects(
		payer.payInvoice({ invoice: invoiceFor(2_500, hash), amountSat: 2_500, challengeId: "c" }),
		(err) => err instanceof PolicyError && err.code === "over_payment_limit",
	);
	guard.pause(1_000);
	await assert.rejects(
		payer.payInvoice({ invoice: invoiceFor(1_000, hash), amountSat: 1_000, challengeId: "c" }),
		(err) => err instanceof PolicyError && err.code === "paused",
	);
	assert.equal(wallet.paid.length, 0);
});

test("payments still in flight count against the daily limit", async () => {
	const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "l402-payer-")), "payments.ndjson"));
	const guard = new SpendGuard({ maxSatsPerPayment: 2_000, maxSatsPerDay: 3_000, ledger });
	/** @type {() => void} */
	let finish = () => {};
	const slow = guard.run(2_000, () => new Promise((resolve) => (finish = () => resolve(undefined))));
	assert.throws(() => guard.check(2_000), (err) => err instanceof PolicyError && err.code === "over_daily_limit");
	finish();
	await slow;
	guard.check(2_000);
});

test("the seller policy pays only the configured seller", async () => {
	const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "l402-payer-")), "payments.ndjson"));
	const guard = new SpendGuard({ maxSatsPerPayment: 2_000, maxSatsPerDay: 5_000, ledger });
	const policy = sellerPolicy({ sellerOrigin: "https://lampo.run", guard });
	await policy.assertAllowed({ url: "https://lampo.run/v1/chat/completions", host: "lampo.run", amountSat: 1_000 });
	await assert.rejects(
		policy.assertAllowed({ url: "https://lampo.run.evil.example/v1/chat/completions", host: "lampo.run.evil.example", amountSat: 1_000 }),
		(err) => err instanceof PolicyError && err.code === "wrong_seller",
	);
	await assert.rejects(
		policy.assertAllowed({ url: "http://lampo.run/v1/chat/completions", host: "lampo.run", amountSat: 1_000 }),
		(err) => err instanceof PolicyError && err.code === "wrong_seller",
	);
});

test("the ledger survives a restart and a torn last line", async () => {
	const dir = mkdtempSync(join(tmpdir(), "l402-ledger-"));
	const path = join(dir, "payments.ndjson");
	const first = new Ledger(path);
	const base = { seller: "s", model: "m", feesSat: 1, paymentHash: "h", preimageHex: "p", preimageOk: true };
	first.append({ ts: new Date().toISOString(), amountSat: 1_000, ...base });
	(await import("node:fs")).appendFileSync(path, '{"ts":"2026');
	const second = new Ledger(path);
	assert.equal(second.payments.length, 1);
	assert.equal(second.spentSince(0), 1_001);
	assert.equal(/** @type {any} */ (second.recent(5)[0]).preimageHex, undefined);
});

test("a wallet's long routing error is shortened for the user", async () => {
	const { guard, ledger, hash } = fixture();
	const { Nip47WalletError } = await import("@getalby/sdk/nwc");
	const noisy = {
		payInvoice: async () => {
			throw new Nip47WalletError(`Failed after 36 attempts. ${"We got temporary_channel_failure. ".repeat(40)}`, "PAYMENT_FAILED");
		},
		lookupInvoice: async () => ({}),
	};
	const payer = new NwcPayer({ client: noisy, guard, ledger });
	await assert.rejects(
		payer.payInvoice({ invoice: invoiceFor(1_000, hash), amountSat: 1_000, challengeId: "c" }),
		(err) => err instanceof WalletError && err.message.startsWith("the wallet could not route the payment") && err.message.length < 320,
	);
	assert.equal(ledger.payments.length, 0);
	assert.equal(guard.pausedUntil, 0, "a definite failure does not pause payments");
});
