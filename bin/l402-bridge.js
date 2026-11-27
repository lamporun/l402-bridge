#!/usr/bin/env node
// @ts-check
// l402-bridge: a local OpenAI-compatible endpoint that pays for inference in
// sats from any Nostr Wallet Connect wallet. Run it, then point any
// OpenAI-compatible tool at http://127.0.0.1:8402/v1.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	DEFAULT_MAX_SATS_PER_DAY,
	DEFAULT_MAX_SATS_PER_PAYMENT,
	DEFAULT_PORT,
	DEFAULT_SELLER,
	startBridge,
} from "../src/start.js";
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

/**
 * @param {string} message
 * @returns {never}
 */
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
	const sellerBase = (args.seller ?? env.L402_BRIDGE_SELLER ?? DEFAULT_SELLER).replace(/\/+$/, "");
	const maxSatsPerPayment = positive(
		args["max-sats-per-payment"] ?? env.L402_BRIDGE_MAX_SATS_PER_PAYMENT,
		DEFAULT_MAX_SATS_PER_PAYMENT,
		"--max-sats-per-payment",
	);
	const maxSatsPerDay = positive(
		args["max-sats-per-day"] ?? env.L402_BRIDGE_MAX_SATS_PER_DAY,
		DEFAULT_MAX_SATS_PER_DAY,
		"--max-sats-per-day",
	);
	if (maxSatsPerDay < maxSatsPerPayment) {
		fail("--max-sats-per-day must be at least --max-sats-per-payment");
	}
	const port = positive(args.port ?? env.L402_BRIDGE_PORT, DEFAULT_PORT, "--port");
	if (port > 65_535) {
		fail("--port must be at most 65535");
	}
	const host = args.host ?? env.L402_BRIDGE_HOST ?? "127.0.0.1";
	const accessKey = args["access-key"] ?? env.L402_BRIDGE_ACCESS_KEY;

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

	const say = (/** @type {string} */ line) => console.log(line);
	const bridge = await startBridge({
		walletUrl,
		sellerBase,
		maxSatsPerPayment,
		maxSatsPerDay,
		port,
		host,
		accessKey,
		allowedOrigins: args["allow-origin"] ?? [],
		dataDir: args["data-dir"] ?? env.L402_BRIDGE_DATA_DIR,
		receipts: !args["no-receipts"],
		log: say,
		chatter: args.quiet ? () => {} : say,
	}).catch((err) => fail(err instanceof Error ? err.message : String(err)));

	const wallet = await bridge.walletInfo();
	const balance = typeof wallet?.balance_sats === "number" ? `, ${formatSat(wallet.balance_sats)} sats` : "";
	say(`⚡ l402-bridge ${VERSION} is ready

  base URL   ${bridge.url}
  API key    ${bridge.accessKey ? "your --access-key" : "any value"}
  seller     ${bridge.sellerBase}
  wallet     ${bridge.walletLabel}${balance}
  limits     ${formatSat(bridge.maxSatsPerPayment)} sats per payment, ${formatSat(bridge.maxSatsPerDay)} sats per day (spent today: ${formatSat(bridge.guard.spentToday())})
  status     ${bridge.statusUrl}
`);

	const stop = () => bridge.close().finally(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
