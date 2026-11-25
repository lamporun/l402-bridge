// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { GENESIS, signReceipt, weightedDebit } from "l402-receipts";
import { parseUsage, ReceiptChecker } from "../src/receipts.js";

const SELLER = "https://seller.test";
const RATES = { input_msat_per_ktok: 1000000, output_msat_per_ktok: 2000000, cached_input_permille: 100 };

/** A token as the bridge stores it, with its macaroon's ids. */
function token(seed = 1) {
	const preimage = sha256(Uint8Array.of(seed));
	const paymentHash = sha256(preimage);
	const tokenId = sha256(Uint8Array.of(seed, 1));
	const id = concatBytes(Uint8Array.of(0, 0), paymentHash, tokenId);
	const mac = concatBytes(Uint8Array.of(2, 2, id.length), id, Uint8Array.of(0, 0, 6, 32), new Uint8Array(32));
	return {
		stored: { macaroonB64: Buffer.from(mac).toString("base64"), preimageHex: bytesToHex(preimage) },
		tokenId: bytesToHex(tokenId),
		paymentHash: bytesToHex(paymentHash),
	};
}

/** A seller that signs receipts for a bundle of 10,000 tokens. */
function seller(seed = 9) {
	const sk = sha256(Uint8Array.of(seed, 7));
	const issuer = bytesToHex(schnorr.getPublicKey(sk));
	const t = token();
	/** @type {any[]} */
	const receipts = [];
	let remaining = 10000;
	/** @param {{ prompt: number, cached: number, completion: number }} usage */
	const debit = (usage, tamper = 0) => {
		const d = weightedDebit(usage, RATES) + tamper;
		remaining = Math.max(0, remaining - d + tamper);
		const r = signReceipt(
			{
				v: 1,
				issuer,
				token: t.tokenId,
				payment_hash: t.paymentHash,
				seq: receipts.length + 1,
				event: receipts.length + 1,
				time: 1795600000,
				model: "m",
				price_sats: 1000,
				source: "split",
				usage,
				rates: RATES,
				debit: d,
				remaining,
				prev: receipts.length ? receipts[receipts.length - 1].id : GENESIS,
			},
			sk,
		);
		receipts.push(r);
	};
	let wellKnownIssuer = issuer;
	/** @type {typeof fetch} */
	const fetchFn = async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/.well-known/l402-receipts.json") {
			return Response.json({ v: 1, issuer: wellKnownIssuer, receipts: `${SELLER}/receipts` });
		}
		if (url.pathname === "/receipts") {
			const auth = new Headers(init?.headers).get("authorization");
			if (auth !== `L402 ${t.stored.macaroonB64}:${t.stored.preimageHex}`) return Response.json({ error: "no" }, { status: 404 });
			const after = Number(url.searchParams.get("after") || 0);
			// Pages of two, like a seller with a small page size.
			const rest = receipts.filter((r) => r.seq > after);
			return Response.json({ receipts: rest.slice(0, 2), proofs: {}, more: rest.length > 2 });
		}
		return new Response("not found", { status: 404 });
	};
	return { t, debit, fetchFn, receipts, setIssuer: (/** @type {string} */ k) => (wellKnownIssuer = k) };
}

/** @param {ReturnType<typeof seller>} s */
function checker(s) {
	const dir = mkdtempSync(join(tmpdir(), "bridge-receipts-"));
	/** @type {string[]} */
	const lines = [];
	const c = new ReceiptChecker({ sellerOrigin: SELLER, fetchFn: s.fetchFn, file: join(dir, "receipts.json"), log: (l) => lines.push(l), retryMs: [0, 0] });
	return { c, lines, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("usage is read from a JSON body and from a stream", () => {
	assert.deepEqual(parseUsage(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } } })), {
		prompt: 12,
		completion: 3,
		cached: 8,
	});
	const stream = [
		'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}',
		'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
		"data: [DONE]",
		"",
	].join("\n\n");
	assert.deepEqual(parseUsage(stream), { prompt: 5, completion: 2, cached: 0 });
	assert.equal(parseUsage("garbage"), null);
});

test("each answer's receipt is verified and remembered", async (t) => {
	const s = seller();
	const k = checker(s);
	t.after(k.cleanup);

	s.debit({ prompt: 1000, cached: 800, completion: 300 });
	await k.c.afterAnswer("m", s.t.stored, { prompt: 1000, cached: 800, completion: 300 });
	s.debit({ prompt: 100, cached: 0, completion: 200 });
	await k.c.afterAnswer("m", s.t.stored, { prompt: 100, cached: 0, completion: 200 });

	assert.deepEqual(k.c.status().problems, []);
	assert.equal(k.c.status().verified, 2);
	assert.match(k.lines.join("\n"), /receipt 1 ✓ 1,000 \+ 300 tokens \(800 cached\) → 587 debited, 9,413 left/);
	assert.match(k.lines.join("\n"), /receipt 2 ✓/);

	// Several debits since the last check arrive in pages and are all checked.
	for (let i = 0; i < 5; i++) s.debit({ prompt: 10 + i, cached: 0, completion: 5 });
	await k.c.afterAnswer("m", s.t.stored, { prompt: 14, cached: 0, completion: 5 });
	assert.deepEqual(k.c.status().problems, []);
	assert.equal(k.c.status().verified, 7);

	// The verified history survives a restart.
	const again = new ReceiptChecker({ sellerOrigin: SELLER, fetchFn: s.fetchFn, file: join(k.dir, "receipts.json"), log: () => {}, retryMs: [0] });
	assert.equal(again.status().verified, 7);
	assert.equal(JSON.parse(readFileSync(join(k.dir, "receipts.json"), "utf8")).issuer, k.c.status().issuer);
});

test("an overcharge, a usage mismatch and a key change are reported", async (t) => {
	const s = seller();
	const k = checker(s);
	t.after(k.cleanup);

	// The seller debits one token more than the usage costs.
	s.debit({ prompt: 100, cached: 0, completion: 200 }, 1);
	await k.c.afterAnswer("m", s.t.stored, { prompt: 100, cached: 0, completion: 200 });
	assert.match(k.c.status().problems.map((p) => p.problem).join("\n"), /debited 335 tokens, its usage at its rates costs 334/);
	assert.equal(k.c.status().verified, 0);

	// The receipt reports other usage than the answer did.
	const s2 = seller();
	const k2 = checker(s2);
	t.after(k2.cleanup);
	s2.debit({ prompt: 150, cached: 0, completion: 200 });
	await k2.c.afterAnswer("m", s2.t.stored, { prompt: 100, cached: 0, completion: 200 });
	assert.match(k2.c.status().problems.map((p) => p.problem).join("\n"), /no receipt reports the usage of the answer/);

	// The seller starts signing with another key.
	s2.setIssuer("ab".repeat(32));
	const k3 = new ReceiptChecker({ sellerOrigin: SELLER, fetchFn: s2.fetchFn, file: join(k2.dir, "receipts.json"), log: () => {}, retryMs: [0] });
	s2.debit({ prompt: 1, cached: 0, completion: 1 });
	await k3.afterAnswer("m", s2.t.stored, { prompt: 1, cached: 0, completion: 1 });
	assert.match(k3.status().problems.map((p) => p.problem).join("\n"), /receipt key changed/);
});

test("sellers without receipts are left alone", async (t) => {
	const k = checker({ ...seller(), fetchFn: async () => new Response("no", { status: 404 }) });
	t.after(k.cleanup);
	await k.c.afterAnswer("m", token().stored, { prompt: 1, cached: 0, completion: 1 });
	assert.deepEqual(k.c.status(), { issuer: null, verified: 0, bundles: [], problems: [] });
	assert.deepEqual(k.lines, []);
});
