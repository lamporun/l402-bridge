// @ts-check
// The local OpenAI-compatible endpoint. A tool sends its request here as if
// to any OpenAI-compatible provider; the bridge forwards it to the seller
// through the paying fetch of @lightninglabs/aperture-client, which answers
// the seller's 402 with an L402 payment from the wallet, caches the paid
// token per model and retries. The response, streamed or not, is passed back
// as it arrives.
//
// What the bridge accepts is deliberately narrow, because it spends money:
// - only the configured seller is ever paid, and only through the limits;
// - by default it listens on the loopback interface and checks the Host
//   header, so a web page cannot reach it through DNS rebinding;
// - a request carrying an Origin header (a browser) is refused unless that
//   origin was allowed, so a page open in your browser cannot spend your
//   sats;
// - an optional access key is required as the tool's API key;
// - the tool's own Authorization header and cookies never reach the seller.

import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createPayingFetch, TokenCache } from "@lightninglabs/aperture-client";
import { PolicyError, WalletError } from "./errors.js";
import { loadModels } from "./menu.js";
import { paymentContext } from "./payer.js";
import { sellerPolicy } from "./policy.js";

// PAID_PATHS are the OpenAI routes forwarded through the paying fetch.
const PAID_PATHS = new Set(["chat/completions", "completions", "embeddings", "responses"]);

// MAX_BODY_BYTES bounds a request body (long agent contexts are large).
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// Response headers passed back to the tool.
const PASS_HEADERS = ["content-type", "cache-control", "x-request-id", "retry-after"];

// MODELS_TTL_MS is how long the model list is cached.
const MODELS_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {{
 *   sellerBase: string,
 *   loopbackOnly: boolean,
 *   accessKey?: string,
 *   allowedOrigins?: string[],
 *   payer: import("@lightninglabs/aperture-core").InvoicePayer,
 *   guard: import("./policy.js").SpendGuard,
 *   tokenStore: import("./store.js").FileTokenStore,
 *   ledger: import("./store.js").Ledger,
 *   walletInfo?: () => Promise<Record<string, unknown> | null>,
 *   fetchFn?: typeof fetch,
 *   log?: (line: string) => void,
 * }} BridgeOptions
 */

/**
 * sendJson writes a JSON response.
 *
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
	res.end(JSON.stringify(body));
}

/**
 * sendError writes an OpenAI-shaped error, which tools show to the user.
 *
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} type
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
function sendError(res, status, type, message, headers) {
	sendJson(res, status, { error: { message: `l402-bridge: ${message}`, type, code: type } }, headers);
}

/**
 * readBody collects the request body, up to MAX_BODY_BYTES.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<Buffer | null>} null when the body is too large
 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			return null;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * sameSecret compares two strings in constant time.
 *
 * @param {string} given
 * @param {string} expected
 */
function sameSecret(given, expected) {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * createBridge builds the HTTP server. It does not listen.
 *
 * @param {BridgeOptions} options
 */
export function createBridge(options) {
	const sellerBase = options.sellerBase.replace(/\/+$/, "");
	const sellerOrigin = new URL(sellerBase).origin;
	const fetchFn = options.fetchFn ?? fetch;
	const log = options.log ?? (() => {});
	const allowedOrigins = new Set(options.allowedOrigins ?? []);
	/** @param {number | undefined} port */
	const loopbackHosts = (port) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];

	const payingFetch = createPayingFetch({
		payer: options.payer,
		tokenCache: options.tokenStore,
		buyerPolicy: sellerPolicy({ sellerOrigin, guard: options.guard }),
		// L402 only: one payment buys a bundle, and the paid token works
		// for every later request on the same model.
		mpp: { intents: [] },
	});

	// firstPurchase serializes requests for a model that has no paid token
	// yet, until the first one has its response headers (and so its token).
	// Without it, a tool that fires several requests at once would buy a
	// bundle for each.
	/** @type {Map<string, Promise<void>>} */
	const purchases = new Map();
	/**
	 * @template T
	 * @param {string} key
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	async function firstPurchase(key, fn) {
		const previous = purchases.get(key);
		if (!previous && options.tokenStore.get(key)) {
			return fn();
		}
		/** @type {() => void} */
		let release = () => {};
		const mine = new Promise((resolve) => {
			release = () => resolve(undefined);
		});
		const chain = (previous ?? Promise.resolve()).then(() => mine);
		purchases.set(key, chain);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (purchases.get(key) === chain) {
				purchases.delete(key);
			}
		}
	}

	/** @type {{ at: number, value: unknown } | null} */
	let modelsCache = null;
	async function models() {
		if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
			return modelsCache.value;
		}
		const value = await loadModels({ sellerBase, sellerOrigin, fetchFn });
		if (value) {
			modelsCache = { at: Date.now(), value };
		}
		return value;
	}

	/**
	 * bundles reads what is left of each paid bundle from the seller's
	 * balance endpoint, where it has one. Nothing is paid for this.
	 */
	async function bundles() {
		const out = [];
		for (const [key, token] of options.tokenStore.entries()) {
			const [origin, model] = key.split("|");
			if (origin !== sellerOrigin || !model) {
				continue;
			}
			/** @type {Record<string, unknown>} */
			const entry = { model };
			try {
				const res = await fetchFn(`${sellerBase}/balance`, {
					headers: { authorization: `L402 ${token.macaroonB64}:${token.preimageHex}` },
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					const body = await res.json();
					for (const field of ["remaining_tokens", "bundle_tokens", "price_sats", "activated"]) {
						if (field in body) {
							entry[field] = body[field];
						}
					}
				}
			} catch {
				// The balance is a convenience.
			}
			out.push(entry);
		}
		return out;
	}

	/**
	 * forward sends one paid request to the seller and streams the answer.
	 *
	 * @param {http.IncomingMessage} req
	 * @param {http.ServerResponse} res
	 * @param {string} path
	 */
	async function forward(req, res, path) {
		const type = String(req.headers["content-type"] ?? "");
		if (!type.toLowerCase().startsWith("application/json")) {
			sendError(res, 415, "invalid_request", "send the request body as application/json");
			return;
		}
		const body = await readBody(req);
		if (body === null) {
			sendError(res, 413, "invalid_request", "the request body is too large");
			return;
		}
		let model;
		try {
			model = JSON.parse(body.toString("utf8"))?.model;
		} catch {
			sendError(res, 400, "invalid_request", "the request body is not valid JSON");
			return;
		}
		if (typeof model !== "string" || model === "" || model.length > 200) {
			sendError(res, 400, "invalid_request", "the request needs a model");
			return;
		}

		// A tool that gives up (or a user who hits stop) aborts the seller
		// request too. A payment already under way still completes, and its
		// token is kept for the next request.
		const controller = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) {
				controller.abort();
			}
		});

		const key = TokenCache.cacheKey(sellerOrigin, model, "POST");
		const started = Date.now();
		let upstream;
		try {
			upstream = await firstPurchase(key, () =>
				paymentContext.run({ model, seller: sellerBase }, () =>
					payingFetch(`${sellerBase}/${path}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: String(req.headers.accept ?? "application/json"),
						},
						body: new Uint8Array(body),
						signal: controller.signal,
						routeId: model,
					}),
				),
			);
		} catch (err) {
			if (controller.signal.aborted) {
				res.destroy();
				return;
			}
			if (err instanceof PolicyError) {
				log(`✋ ${model}: ${err.message}`);
				sendError(res, 402, "l402_bridge_limit", err.message);
			} else if (err instanceof WalletError) {
				log(`✗ ${model}: wallet: ${err.message}`);
				sendError(res, 502, "l402_bridge_wallet", `payment not made: ${err.message}`);
			} else {
				const message = err instanceof Error ? err.message : String(err);
				log(`✗ ${model}: ${message}`);
				sendError(res, 502, "l402_bridge_upstream", `could not reach the seller: ${message}`);
			}
			return;
		}

		if (upstream.status === 402) {
			// The paying fetch hands back a 402 it could not answer: no
			// L402 offer, or a seller that refused the paid credential.
			await upstream.body?.cancel();
			sendError(res, 402, "l402_bridge_unpaid", "the seller asked for a payment the bridge could not make");
			return;
		}

		/** @type {Record<string, string>} */
		const headers = {};
		for (const name of PASS_HEADERS) {
			const value = upstream.headers.get(name);
			if (value) {
				headers[name] = value;
			}
		}
		res.writeHead(upstream.status, headers);
		if (!upstream.body) {
			res.end();
			return;
		}
		try {
			await pipeline(Readable.fromWeb(/** @type {import("node:stream/web").ReadableStream} */ (upstream.body)), res);
		} catch {
			// The tool went away, or the seller's stream broke midway.
			res.destroy();
		}
		log(`→ ${model} ${upstream.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	}

	/**
	 * @param {http.IncomingMessage} req
	 * @param {http.ServerResponse} res
	 */
	async function handle(req, res) {
		const url = new URL(req.url ?? "/", "http://bridge.invalid");

		// DNS rebinding: a page on evil.example resolving to 127.0.0.1
		// would send Host: evil.example.
		const hostHeader = String(req.headers.host ?? "").toLowerCase();
		if (options.loopbackOnly && !loopbackHosts(req.socket.localPort).includes(hostHeader)) {
			sendError(res, 403, "forbidden", "unexpected Host header");
			return;
		}

		// Browsers always send Origin on cross-origin requests; tools
		// calling from a program do not.
		const origin = req.headers.origin;
		/** @type {Record<string, string>} */
		const cors = {};
		if (origin !== undefined) {
			if (!allowedOrigins.has(origin)) {
				sendError(res, 403, "forbidden", `requests from the browser origin ${origin} are not allowed (see --allow-origin)`);
				return;
			}
			cors["access-control-allow-origin"] = origin;
			cors.vary = "Origin";
			if (req.method === "OPTIONS") {
				res.writeHead(204, {
					...cors,
					"access-control-allow-methods": "GET, POST",
					"access-control-allow-headers": "authorization, content-type",
					"access-control-max-age": "600",
				});
				res.end();
				return;
			}
			for (const [name, value] of Object.entries(cors)) {
				res.setHeader(name, value);
			}
		}

		if (options.accessKey) {
			const auth = String(req.headers.authorization ?? "");
			const given = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
			if (!sameSecret(given, options.accessKey)) {
				sendError(res, 401, "unauthorized", "use the bridge's access key as the API key");
				return;
			}
		}

		if (req.method === "GET" && url.pathname === "/healthz") {
			sendJson(res, 200, { ok: true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/l402/status") {
			const guard = options.guard;
			sendJson(res, 200, {
				seller: sellerBase,
				wallet: options.walletInfo ? await options.walletInfo() : null,
				limits: {
					max_sats_per_payment: guard.maxSatsPerPayment,
					max_sats_per_day: guard.maxSatsPerDay,
					spent_today_sats: guard.spentToday(),
				},
				bundles: await bundles(),
				recent_payments: options.ledger.recent(10),
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/v1/models") {
			const list = await models();
			if (list) {
				sendJson(res, 200, list);
			} else {
				sendError(res, 502, "l402_bridge_upstream", "the seller did not return a model list");
			}
			return;
		}
		const path = url.pathname.startsWith("/v1/") ? url.pathname.slice(4) : "";
		if (req.method === "POST" && PAID_PATHS.has(path)) {
			await forward(req, res, path);
			return;
		}
		sendError(res, 404, "not_found", `no route for ${req.method} ${url.pathname}`);
	}

	return http.createServer((req, res) => {
		handle(req, res).catch((err) => {
			log(`✗ internal error: ${err instanceof Error ? err.message : String(err)}`);
			sendError(res, 500, "internal", "internal error");
		});
	});
}
