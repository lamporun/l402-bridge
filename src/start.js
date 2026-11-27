// @ts-check
// startBridge builds, checks and starts a bridge from plain options. The
// command line and programs that embed the bridge (such as the OpenClaw
// plugin) share it, so the wiring and its safety checks live in one place.

import { homedir } from "node:os";
import { join } from "node:path";
import { NWCClient } from "@getalby/sdk/nwc";
import { NwcPayer } from "./payer.js";
import { SpendGuard } from "./policy.js";
import { ReceiptChecker } from "./receipts.js";
import { createBridge } from "./server.js";
import { ensurePrivateDir, FileTokenStore, Ledger } from "./store.js";
import { formatSat } from "./util.js";

export const DEFAULT_SELLER = "https://lampo.run/v1";
export const DEFAULT_PORT = 8402;
export const DEFAULT_MAX_SATS_PER_PAYMENT = 1_000;
export const DEFAULT_MAX_SATS_PER_DAY = 10_000;

/** ConfigError is a setting the bridge refuses to start with. */
export class ConfigError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "ConfigError";
	}
}

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

/**
 * @typedef {{
 *   walletUrl?: string,
 *   client?: import("./payer.js").NwcLike & { getInfo?: () => Promise<any>, getBalance?: () => Promise<{ balance: number }>, close?: () => void },
 *   sellerBase?: string,
 *   maxSatsPerPayment?: number,
 *   maxSatsPerDay?: number,
 *   port?: number,
 *   host?: string,
 *   accessKey?: string,
 *   allowedOrigins?: string[],
 *   dataDir?: string,
 *   receipts?: boolean,
 *   log?: (line: string) => void,
 *   chatter?: (line: string) => void,
 *   fetchFn?: typeof fetch,
 *   walletTimeoutMs?: number,
 *   paymentErrorStatus?: number,
 *   limitHints?: import("./policy.js").LimitHints,
 * }} StartOptions
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 */
function whole(value, name, min, max) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * resolveSettings checks the options and fills in the defaults, without
 * touching the wallet, the disk or the network.
 *
 * @param {StartOptions} options
 */
export function resolveSettings(options) {
	const sellerBase = (options.sellerBase || DEFAULT_SELLER).replace(/\/+$/, "");
	/** @type {URL} */
	let seller;
	try {
		seller = new URL(sellerBase);
	} catch {
		throw new ConfigError(`the seller is not a URL: ${sellerBase}`);
	}
	const localSeller = ["localhost", "127.0.0.1", "[::1]"].includes(seller.hostname);
	if (seller.protocol !== "https:" && !(seller.protocol === "http:" && localSeller)) {
		throw new ConfigError("the seller must use https (plain http is allowed only for a seller on this machine)");
	}
	const maxSatsPerPayment = whole(options.maxSatsPerPayment ?? DEFAULT_MAX_SATS_PER_PAYMENT, "maxSatsPerPayment", 1, 21e14);
	const maxSatsPerDay = whole(options.maxSatsPerDay ?? DEFAULT_MAX_SATS_PER_DAY, "maxSatsPerDay", 1, 21e14);
	if (maxSatsPerDay < maxSatsPerPayment) {
		throw new ConfigError("the daily limit must be at least the per-payment limit");
	}
	const port = whole(options.port ?? DEFAULT_PORT, "port", 0, 65_535);
	const host = options.host || "127.0.0.1";
	const loopbackOnly = LOOPBACK.includes(host);
	const accessKey = options.accessKey || undefined;
	if (!loopbackOnly && !accessKey) {
		throw new ConfigError(`listening on ${host} lets other machines spend your sats; set an access key too`);
	}
	if (accessKey !== undefined && accessKey.length < 16) {
		throw new ConfigError("the access key must be at least 16 characters");
	}
	if (!options.client) {
		if (!options.walletUrl) {
			throw new ConfigError("no wallet: give the bridge your wallet's Nostr Wallet Connect string");
		}
		try {
			NWCClient.parseWalletConnectUrl(options.walletUrl, true);
		} catch {
			throw new ConfigError("the wallet string is not a valid nostr+walletconnect:// connection string");
		}
	}
	return {
		sellerBase,
		sellerOrigin: seller.origin,
		maxSatsPerPayment,
		maxSatsPerDay,
		port,
		host,
		loopbackOnly,
		accessKey,
		allowedOrigins: options.allowedOrigins ?? [],
		dataDir: options.dataDir || join(homedir(), ".l402-bridge"),
		receipts: options.receipts !== false,
	};
}

/**
 * withTimeout bounds a wallet call made at startup.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms).unref()),
	]);
}

/**
 * startBridge checks the wallet, opens the data directory and listens. It
 * throws a ConfigError for a setting it refuses, and an ordinary Error when
 * the port cannot be opened.
 *
 * @param {StartOptions} options
 */
export async function startBridge(options) {
	const s = resolveSettings(options);
	const say = options.log ?? (() => {});
	const chatter = options.chatter ?? say;
	const walletTimeoutMs = options.walletTimeoutMs ?? 20_000;
	const client = options.client ?? new NWCClient({ nostrWalletConnectUrl: /** @type {string} */ (options.walletUrl) });

	try {
		// Check the wallet before listening: a bridge that cannot pay should
		// say so now, not on the first request.
		let walletLabel = "NWC wallet";
		if (client.getInfo) {
			try {
				const info = await withTimeout(client.getInfo(), walletTimeoutMs);
				if (Array.isArray(info.methods) && !info.methods.includes("pay_invoice")) {
					throw new ConfigError("this wallet connection cannot pay invoices; create one with the pay_invoice permission");
				}
				if (info.network && !["mainnet", "bitcoin"].includes(String(info.network).toLowerCase())) {
					say(`  note: the wallet reports network ${info.network}; the seller must be on the same network`);
				}
				walletLabel = info.alias ? `${info.alias} (NWC)` : walletLabel;
			} catch (err) {
				if (err instanceof ConfigError) {
					throw err;
				}
				say(`  note: the wallet did not answer get_info (${err instanceof Error ? err.message : String(err)}); continuing`);
			}
		}

		/** @type {{ at: number, value: Record<string, unknown> } | null} */
		let walletCache = null;
		const walletInfo = async () => {
			if (walletCache && Date.now() - walletCache.at < 30_000) {
				return walletCache.value;
			}
			/** @type {Record<string, unknown>} */
			const value = { name: walletLabel };
			if (client.getBalance) {
				try {
					const { balance } = await withTimeout(client.getBalance(), 10_000);
					value.balance_sats = Math.floor(balance / 1000);
				} catch {
					// The connection may not be allowed to read the balance.
				}
			}
			walletCache = { at: Date.now(), value };
			return value;
		};

		ensurePrivateDir(s.dataDir);
		const ledger = new Ledger(join(s.dataDir, "payments.ndjson"));
		const guard = new SpendGuard({
			maxSatsPerPayment: s.maxSatsPerPayment,
			maxSatsPerDay: s.maxSatsPerDay,
			ledger,
			hints: options.limitHints,
		});
		const tokenStore = new FileTokenStore(join(s.dataDir, "tokens.json"));
		const payer = new NwcPayer({
			client,
			guard,
			ledger,
			onPaid: (payment) => {
				const fee = payment.feesSat ? ` + ${formatSat(payment.feesSat)} fee` : "";
				say(
					`⚡ paid ${formatSat(payment.amountSat)} sats${fee} · new bundle for ${payment.model} · ` +
						`today ${formatSat(guard.spentToday())} / ${formatSat(s.maxSatsPerDay)} sats`,
				);
			},
		});
		const fetchFn = options.fetchFn ?? fetch;
		const receipts = s.receipts
			? new ReceiptChecker({ sellerOrigin: s.sellerOrigin, fetchFn, file: join(s.dataDir, "receipts.json"), log: say })
			: undefined;

		const server = createBridge({
			sellerBase: s.sellerBase,
			loopbackOnly: s.loopbackOnly,
			accessKey: s.accessKey,
			allowedOrigins: s.allowedOrigins,
			payer,
			guard,
			tokenStore,
			ledger,
			walletInfo,
			log: chatter,
			receipts,
			fetchFn: options.fetchFn,
			paymentErrorStatus: options.paymentErrorStatus,
		});

		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(s.port, s.host, () => resolve(undefined));
		}).catch((err) => {
			throw new Error(`cannot listen on ${s.host}:${s.port}: ${err.message}`);
		});
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : s.port;
		const shownHost = s.host.includes(":") ? `[${s.host}]` : s.host;

		let closed = false;
		return {
			...s,
			port,
			url: `http://${shownHost}:${port}/v1`,
			statusUrl: `http://${shownHost}:${port}/l402/status`,
			walletLabel,
			walletInfo,
			guard,
			server,
			/** close stops listening and disconnects from the wallet. */
			close: async () => {
				if (closed) {
					return;
				}
				closed = true;
				await new Promise((resolve) => {
					server.close(() => resolve(undefined));
					server.closeAllConnections?.();
				});
				client.close?.();
			},
		};
	} catch (err) {
		client.close?.();
		throw err;
	}
}
