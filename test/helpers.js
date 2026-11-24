// @ts-check
// Test doubles: a fake L402 seller that issues real, signed BOLT11 invoices
// and checks preimages like aperture does, and a fake NWC wallet that pays
// them.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Nip47ReplyTimeoutError, Nip47WalletError } from "@getalby/sdk/nwc";
import bolt11 from "bolt11";
import { NwcPayer } from "../src/payer.js";
import { SpendGuard } from "../src/policy.js";
import { createBridge } from "../src/server.js";
import { FileTokenStore, Ledger } from "../src/store.js";

// A throwaway node key, used only to sign test invoices.
const NODE_KEY = "e126f68f7eafcc8b74f54d269fe206be715000f94dac067d1c04a8ca3b2db734";

/**
 * invoiceFor signs a mainnet BOLT11 invoice for the amount and hash.
 *
 * @param {number} sats
 * @param {string} paymentHash
 */
export function invoiceFor(sats, paymentHash) {
	const encoded = bolt11.encode({
		network: { bech32: "bc", pubKeyHash: 0, scriptHash: 5, validWitnessVersions: [0, 1] },
		satoshis: sats,
		timestamp: Math.floor(Date.now() / 1000),
		tags: [
			{ tagName: "payment_hash", data: paymentHash },
			{ tagName: "payment_secret", data: randomBytes(32).toString("hex") },
			{ tagName: "description", data: "test bundle" },
			{ tagName: "expire_time", data: 600 },
		],
	});
	return /** @type {string} */ (bolt11.sign(encoded, NODE_KEY).paymentRequest);
}

/** @param {string} hex */
const sha256 = (hex) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");

/**
 * startSeller runs a fake seller on a free port.
 *
 * @param {{
 *   priceSats?: number | ((model: string) => number),
 *   bundleRequests?: number,
 *   freeModels?: boolean,
 *   menu?: unknown,
 *   redirectTo?: string,
 * }} [options]
 */
export async function startSeller(options = {}) {
	const price = (/** @type {string} */ model) =>
		typeof options.priceSats === "function" ? options.priceSats(model) : (options.priceSats ?? 1_000);
	const bundleRequests = options.bundleRequests ?? 100;
	/** @type {Map<string, string>} preimage by payment hash */
	const preimages = new Map();
	/** @type {Map<string, { hash: string, model: string, left: number }>} */
	const macaroons = new Map();
	const seen = { challenges: 0, paid: 0, authorizations: /** @type {string[]} */ ([]), bodies: /** @type {any[]} */ ([]) };

	/**
	 * @param {http.ServerResponse} res
	 * @param {string} model
	 */
	function challenge(res, model) {
		const preimage = randomBytes(32).toString("hex");
		const hash = sha256(preimage);
		preimages.set(hash, preimage);
		const macaroon = randomBytes(24).toString("base64");
		macaroons.set(macaroon, { hash, model, left: bundleRequests });
		seen.challenges++;
		res.writeHead(402, {
			"www-authenticate": `L402 macaroon="${macaroon}", invoice="${invoiceFor(price(model), hash)}"`,
			"content-type": "text/plain",
		});
		res.end("payment required");
	}

	/**
	 * credential validates an L402 header and returns its bundle.
	 *
	 * @param {string | undefined} header
	 */
	function credential(header) {
		const match = /^L402 ([^:]+):([0-9a-f]{64})$/.exec(header ?? "");
		if (!match) {
			return null;
		}
		const bundle = macaroons.get(match[1]);
		return bundle && sha256(match[2]) === bundle.hash ? bundle : null;
	}

	const server = http.createServer((req, res) => {
		const chunks = /** @type {Buffer[]} */ ([]);
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.authorizations.push(String(req.headers.authorization ?? ""));
			if (options.redirectTo) {
				res.writeHead(307, { location: options.redirectTo }).end();
				return;
			}
			if (req.method === "GET" && req.url === "/pi402.json") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(options.menu ?? { version: 1, models: { "acme/Fast-1": { name: "Fast 1", contextTokens: 128_000 } } }));
				return;
			}
			if (req.method === "GET" && req.url === "/v1/models") {
				if (!options.freeModels) {
					challenge(res, "");
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "acme/Listed", object: "model" }] }));
				return;
			}
			if (req.method === "GET" && req.url === "/v1/balance") {
				const bundle = credential(req.headers.authorization);
				if (!bundle) {
					res.writeHead(401).end();
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ remaining_tokens: bundle.left * 1000, bundle_tokens: bundleRequests * 1000, activated: true }));
				return;
			}
			if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
				res.writeHead(404).end();
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			seen.bodies.push(body);
			const bundle = credential(req.headers.authorization);
			if (!bundle || bundle.model !== body.model || bundle.left <= 0) {
				challenge(res, body.model);
				return;
			}
			bundle.left--;
			seen.paid++;
			if (body.stream) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				for (const word of ["paid ", "in ", "sats"]) {
					res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })}\n\n`);
				}
				res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
				res.end("data: [DONE]\n\n");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "c1",
					object: "chat.completion",
					model: body.model,
					choices: [{ index: 0, message: { role: "assistant", content: "paid in sats" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
				}),
			);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	return {
		base: `http://127.0.0.1:${port}/v1`,
		preimages,
		seen,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			}),
	};
}

/**
 * fakeWallet pays the fake seller's invoices by looking up their preimages.
 *
 * @param {Map<string, string>} preimages
 * @param {{ mode?: "ok" | "insufficient" | "timeout-then-settled" | "timeout-unknown" | "wrong-preimage", feesMsat?: number }} [options]
 */
export function fakeWallet(preimages, options = {}) {
	const mode = options.mode ?? "ok";
	const paid = /** @type {string[]} */ ([]);
	return {
		paid,
		/** @param {{ invoice: string }} request */
		async payInvoice({ invoice }) {
			const hash = /** @type {string} */ (
				bolt11.decode(invoice).tags.find((t) => t.tagName === "payment_hash")?.data
			);
			if (mode === "insufficient") {
				throw new Nip47WalletError("not enough funds", "INSUFFICIENT_BALANCE");
			}
			paid.push(hash);
			if (mode === "timeout-then-settled" || mode === "timeout-unknown") {
				throw new Nip47ReplyTimeoutError("reply timeout", "INTERNAL");
			}
			if (mode === "wrong-preimage") {
				return { preimage: "11".repeat(32), fees_paid: 0 };
			}
			return { preimage: /** @type {string} */ (preimages.get(hash)), fees_paid: options.feesMsat ?? 0 };
		},
		/** @param {{ payment_hash: string }} request */
		async lookupInvoice({ payment_hash }) {
			if (mode === "timeout-unknown") {
				throw new Nip47WalletError("lookup not supported", "NOT_IMPLEMENTED");
			}
			if (!paid.includes(payment_hash)) {
				throw new Nip47WalletError("not found", "NOT_FOUND");
			}
			return { state: "settled", preimage: preimages.get(payment_hash), fees_paid: 0 };
		},
	};
}

/**
 * startBridge runs a bridge on a free loopback port against a seller.
 *
 * @param {{
 *   sellerBase: string,
 *   wallet: ReturnType<typeof fakeWallet>,
 *   maxSatsPerPayment?: number,
 *   maxSatsPerDay?: number,
 *   accessKey?: string,
 *   allowedOrigins?: string[],
 * }} options
 */
export async function startBridge(options) {
	const dataDir = mkdtempSync(join(tmpdir(), "l402-bridge-test-"));
	const ledger = new Ledger(join(dataDir, "payments.ndjson"));
	const guard = new SpendGuard({
		maxSatsPerPayment: options.maxSatsPerPayment ?? 1_000,
		maxSatsPerDay: options.maxSatsPerDay ?? 10_000,
		ledger,
	});
	const tokenStore = new FileTokenStore(join(dataDir, "tokens.json"));
	const payer = new NwcPayer({
		client: options.wallet,
		guard,
		ledger,
		settleTimeoutMs: 300,
		pollMs: 10,
		pauseMs: 60_000,
	});
	const lines = /** @type {string[]} */ ([]);
	const server = createBridge({
		sellerBase: options.sellerBase,
		loopbackOnly: true,
		accessKey: options.accessKey,
		allowedOrigins: options.allowedOrigins,
		payer,
		guard,
		tokenStore,
		ledger,
		walletInfo: async () => ({ name: "fake", balance_sats: 21_000 }),
		log: (line) => lines.push(line),
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	return {
		base: `http://127.0.0.1:${port}/v1`,
		origin: `http://127.0.0.1:${port}`,
		port,
		dataDir,
		ledger,
		guard,
		lines,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			}),
	};
}
