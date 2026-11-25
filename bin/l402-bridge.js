#!/usr/bin/env node
// @ts-check
// l402-bridge: a local OpenAI-compatible endpoint that pays for inference in
// sats from any Nostr Wallet Connect wallet. Run it, then point any
// OpenAI-compatible tool at http://127.0.0.1:8402/v1.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NWCClient } from "@getalby/sdk/nwc";
import { NwcPayer } from "../src/payer.js";
import { SpendGuard } from "../src/policy.js";
import { ReceiptChecker } from "../src/receipts.js";
import { createBridge } from "../src/server.js";
import { ensurePrivateDir, FileTokenStore, Ledger } from "../src/store.js";
import { formatSat } from "../src/util.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `l402-bridge ${VERSION}

Let any OpenAI-compatible tool pay for its own inference in sats. The bridge
listens locally, forwards requests to an L402 seller, and pays the seller's
invoices from your Nostr Wallet Connect (NWC) wallet, within your limits.

Usage:
  NWC_URL="nostr+walletconnect://..." npx github:lamporun/l402-bridge [options]

Wallet (one of):
  NWC_URL                        the NWC connection string, from your wallet's
                                 app connections (Alby Hub, Primal, Coinos, Zeus...)
  --wallet-file <path>           a file holding the NWC connection string

Options:
  --seller <url>                 the seller's OpenAI base URL
                                 (default https://lampo.run/v1)
  --max-sats-per-payment <sats>  refuse any single payment above this (default 1000)
  --max-sats-per-day <sats>      refuse payments past this much per day (default 10000)
  --port <port>                  local port (default 8402)
  --host <address>               listen address (default 127.0.0.1); any other
                                 address requires --access-key
  --access-key <key>             require this as the tool's API key
                                 (or L402_BRIDGE_ACCESS_KEY)
  --allow-origin <origin>        let a browser app at this origin call the bridge
                                 (repeatable; browsers are refused by default)
  --data-dir <dir>               where paid tokens and the payment log live
                                 (default ~/.l402-bridge)
  --no-receipts                  do not check the seller's signed receipts
                                 (checked by default when the seller signs them)
  --quiet                        log payments only
  -h, --help                     show this help
  -v, --version                  show the version

Then point your tool at:
  base URL  http://127.0.0.1:8402/v1
  API key   any value (or your --access-key)
`;

/** @param {string} message */
function fail(message) {
	console.error(`l402-bridge: ${message}`);
	process.exit(1);
}

/**
 * positive parses a positive integer option.
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {string} name
 */
function positive(raw, fallback, name) {
	if (raw === undefined || raw === "") {
		return fallback;
	}
	if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
		fail(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
	}
	return Number(raw);
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

async function main() {
	let parsed;
	try {
		parsed = parseArgs({
			options: {
				seller: { type: "string" },
				"max-sats-per-payment": { type: "string" },
				"max-sats-per-day": { type: "string" },
				port: { type: "string" },
				host: { type: "string" },
				"access-key": { type: "string" },
				"allow-origin": { type: "string", multiple: true },
				"wallet-file": { type: "string" },
				"data-dir": { type: "string" },
				"no-receipts": { type: "boolean" },
				quiet: { type: "boolean" },
				help: { type: "boolean", short: "h" },
				version: { type: "boolean", short: "v" },
			},
			strict: true,
		});
	} catch (err) {
		fail(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
		return;
	}
	const args = parsed.values;
	if (args.help) {
		process.stdout.write(HELP);
		return;
	}
	if (args.version) {
		console.log(VERSION);
		return;
	}

	const env = process.env;
	const sellerBase = (args.seller ?? env.L402_BRIDGE_SELLER ?? "https://lampo.run/v1").replace(/\/+$/, "");
	let seller;
	try {
		seller = new URL(sellerBase);
	} catch {
		fail(`--seller is not a URL: ${sellerBase}`);
		return;
	}
	const localSeller = ["localhost", "127.0.0.1", "[::1]"].includes(seller.hostname);
	if (seller.protocol !== "https:" && !(seller.protocol === "http:" && localSeller)) {
		fail("--seller must use https (plain http is allowed only for a seller on this machine)");
	}

	const maxSatsPerPayment = positive(
		args["max-sats-per-payment"] ?? env.L402_BRIDGE_MAX_SATS_PER_PAYMENT,
		1_000,
		"--max-sats-per-payment",
	);
	const maxSatsPerDay = positive(args["max-sats-per-day"] ?? env.L402_BRIDGE_MAX_SATS_PER_DAY, 10_000, "--max-sats-per-day");
	if (maxSatsPerDay < maxSatsPerPayment) {
		fail("--max-sats-per-day must be at least --max-sats-per-payment");
	}
	const port = positive(args.port ?? env.L402_BRIDGE_PORT, 8402, "--port");
	if (port > 65_535) {
		fail("--port must be at most 65535");
	}
	const host = args.host ?? env.L402_BRIDGE_HOST ?? "127.0.0.1";
	const loopbackOnly = ["127.0.0.1", "localhost", "::1"].includes(host);
	const accessKey = args["access-key"] ?? env.L402_BRIDGE_ACCESS_KEY;
	if (!loopbackOnly && !accessKey) {
		fail(`listening on ${host} lets other machines spend your sats; set --access-key too`);
	}
	if (accessKey !== undefined && accessKey.length < 16) {
		fail("--access-key must be at least 16 characters");
	}
	const dataDir = args["data-dir"] ?? env.L402_BRIDGE_DATA_DIR ?? join(homedir(), ".l402-bridge");

	let walletUrl = env.NWC_URL;
	if (args["wallet-file"]) {
		try {
			walletUrl = readFileSync(args["wallet-file"], "utf8").trim();
		} catch (err) {
			fail(`cannot read --wallet-file: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (!walletUrl) {
		fail("no wallet: set NWC_URL to your wallet's Nostr Wallet Connect string, or use --wallet-file\n\nRun with --help for details.");
		return;
	}
	/** @type {NWCClient} */
	let client;
	try {
		NWCClient.parseWalletConnectUrl(walletUrl, true);
		client = new NWCClient({ nostrWalletConnectUrl: walletUrl });
	} catch {
		fail("NWC_URL is not a valid nostr+walletconnect:// connection string");
		return;
	}

	const say = (/** @type {string} */ line) => console.log(line);
	const chatter = args.quiet ? () => {} : say;

	// Check the wallet before listening: a bridge that cannot pay should say
	// so now, not on the first request.
	let walletLabel = "NWC wallet";
	try {
		const info = await withTimeout(client.getInfo(), 20_000);
		if (Array.isArray(info.methods) && !info.methods.includes("pay_invoice")) {
			fail("this wallet connection cannot pay invoices; create one with the pay_invoice permission");
		}
		if (info.network && !["mainnet", "bitcoin"].includes(String(info.network).toLowerCase())) {
			say(`  note: the wallet reports network ${info.network}; the seller must be on the same network`);
		}
		walletLabel = info.alias ? `${info.alias} (NWC)` : walletLabel;
	} catch (err) {
		say(`  note: the wallet did not answer get_info (${err instanceof Error ? err.message : String(err)}); continuing`);
	}

	/** @type {{ at: number, value: Record<string, unknown> | null } | null} */
	let walletCache = null;
	async function walletInfo() {
		if (walletCache && Date.now() - walletCache.at < 30_000) {
			return walletCache.value;
		}
		/** @type {Record<string, unknown>} */
		const value = { name: walletLabel };
		try {
			const { balance } = await withTimeout(client.getBalance(), 10_000);
			value.balance_sats = Math.floor(balance / 1000);
		} catch {
			// The connection may not be allowed to read the balance.
		}
		walletCache = { at: Date.now(), value };
		return value;
	}

	ensurePrivateDir(dataDir);
	const ledger = new Ledger(join(dataDir, "payments.ndjson"));
	const guard = new SpendGuard({ maxSatsPerPayment, maxSatsPerDay, ledger });
	const tokenStore = new FileTokenStore(join(dataDir, "tokens.json"));
	const payer = new NwcPayer({
		client,
		guard,
		ledger,
		onPaid: (payment) => {
			const fee = payment.feesSat ? ` + ${formatSat(payment.feesSat)} fee` : "";
			say(
				`⚡ paid ${formatSat(payment.amountSat)} sats${fee} · new bundle for ${payment.model} · ` +
					`today ${formatSat(guard.spentToday())} / ${formatSat(maxSatsPerDay)} sats`,
			);
		},
	});

	const receipts = args["no-receipts"]
		? undefined
		: new ReceiptChecker({ sellerOrigin: seller.origin, fetchFn: fetch, file: join(dataDir, "receipts.json"), log: say });

	const server = createBridge({
		sellerBase,
		loopbackOnly,
		accessKey,
		allowedOrigins: args["allow-origin"] ?? [],
		payer,
		guard,
		tokenStore,
		ledger,
		walletInfo,
		log: chatter,
		receipts,
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve(undefined));
	}).catch((err) => fail(`cannot listen on ${host}:${port}: ${err.message}`));

	const wallet = await walletInfo();
	const balance = typeof wallet?.balance_sats === "number" ? `, ${formatSat(wallet.balance_sats)} sats` : "";
	const shownHost = host.includes(":") ? `[${host}]` : host;
	say(`⚡ l402-bridge ${VERSION} is ready

  base URL   http://${shownHost}:${port}/v1
  API key    ${accessKey ? "your --access-key" : "any value"}
  seller     ${sellerBase}
  wallet     ${walletLabel}${balance}
  limits     ${formatSat(maxSatsPerPayment)} sats per payment, ${formatSat(maxSatsPerDay)} sats per day (spent today: ${formatSat(guard.spentToday())})
  status     http://${shownHost}:${port}/l402/status
`);

	const stop = () => {
		server.close();
		client.close();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
