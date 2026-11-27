// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, resolveSettings, startBridge } from "../src/index.js";
import { fakeWallet, startSeller } from "./helpers.js";

const WALLET = `nostr+walletconnect://${"a".repeat(64)}?relay=wss://relay.example&secret=${"b".repeat(64)}`;

test("settings are checked before anything starts", () => {
	const ok = resolveSettings({ walletUrl: WALLET });
	assert.equal(ok.sellerBase, "https://lampo.run/v1");
	assert.equal(ok.port, 8402);
	assert.equal(ok.maxSatsPerPayment, 1_000);
	assert.equal(ok.maxSatsPerDay, 10_000);
	assert.equal(ok.loopbackOnly, true);

	/** @type {Array<[object, RegExp]>} */
	const refused = [
		[{}, /no wallet/],
		[{ walletUrl: "nostr+walletconnect://nope" }, /not a valid/],
		[{ walletUrl: WALLET, sellerBase: "http://seller.example/v1" }, /https/],
		[{ walletUrl: WALLET, maxSatsPerPayment: 0 }, /maxSatsPerPayment/],
		[{ walletUrl: WALLET, maxSatsPerPayment: 2_000, maxSatsPerDay: 1_000 }, /daily limit/],
		[{ walletUrl: WALLET, port: 70_000 }, /port/],
		[{ walletUrl: WALLET, host: "0.0.0.0" }, /access key/],
		[{ walletUrl: WALLET, host: "0.0.0.0", accessKey: "short" }, /16 characters/],
	];
	for (const [options, message] of refused) {
		assert.throws(() => resolveSettings(/** @type {any} */ (options)), (err) => err instanceof ConfigError && message.test(err.message));
	}
});

test("a started bridge pays, serves, reports and closes", async () => {
	const seller = await startSeller();
	const wallet = fakeWallet(seller.preimages);
	const dataDir = join(mkdtempSync(join(tmpdir(), "l402-start-")), "data");
	/** @type {string[]} */
	const lines = [];
	const bridge = await startBridge({
		client: { ...wallet, getInfo: async () => ({ alias: "Test wallet", methods: ["pay_invoice"] }), getBalance: async () => ({ balance: 5_000_000 }) },
		sellerBase: seller.base,
		port: 0,
		dataDir,
		receipts: false,
		log: (line) => lines.push(line),
	});
	try {
		assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
		assert.notEqual(bridge.port, 0);
		assert.equal(bridge.walletLabel, "Test wallet (NWC)");
		assert.deepEqual(await bridge.walletInfo(), { name: "Test wallet (NWC)", balance_sats: 5_000 });

		const res = await fetch(`${bridge.url}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }] }),
		});
		assert.equal(res.status, 200);
		assert.equal((await res.json()).choices[0].message.content, "paid in sats");
		assert.equal(wallet.paid.length, 1);
		assert.equal(bridge.guard.spentToday(), 1_000);
		assert.ok(lines.some((l) => l.startsWith("⚡ paid 1,000 sats")), lines.join("\n"));
		assert.equal(statSync(dataDir).mode & 0o777, 0o700);
	} finally {
		await bridge.close();
		await seller.close();
	}
	await assert.rejects(fetch(`${bridge.url}/models`));
});

test("a wallet connection that cannot pay is refused at start", async () => {
	const wallet = fakeWallet(new Map());
	await assert.rejects(
		startBridge({ client: { ...wallet, getInfo: async () => ({ methods: ["get_balance"] }) }, port: 0, dataDir: mkdtempSync(join(tmpdir(), "l402-start-")) }),
		(err) => err instanceof ConfigError && /pay_invoice/.test(err.message),
	);
});

test("a busy port is reported as an error", async () => {
	const seller = await startSeller();
	const first = await startBridge({ client: fakeWallet(seller.preimages), sellerBase: seller.base, port: 0, dataDir: mkdtempSync(join(tmpdir(), "l402-start-")), receipts: false });
	try {
		await assert.rejects(
			startBridge({ client: fakeWallet(seller.preimages), sellerBase: seller.base, port: first.port, dataDir: mkdtempSync(join(tmpdir(), "l402-start-")), receipts: false }),
			/cannot listen/,
		);
	} finally {
		await first.close();
		await seller.close();
	}
});

test("a host can ask for another status on payment refusals", async () => {
	const seller = await startSeller({ priceSats: 5_000 });
	const bridge = await startBridge({
		client: fakeWallet(seller.preimages),
		sellerBase: seller.base,
		port: 0,
		dataDir: mkdtempSync(join(tmpdir(), "l402-start-")),
		receipts: false,
		paymentErrorStatus: 400,
		limitHints: { perPayment: (sats) => `Set maxSatsPerPayment to ${sats}.`, perDay: () => "Raise maxSatsPerDay." },
	});
	try {
		const res = await fetch(`${bridge.url}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }] }),
		});
		assert.equal(res.status, 400);
		const body = await res.json();
		assert.equal(body.error.code, "l402_bridge_limit");
		assert.match(body.error.message, /5,000 sats/);
		assert.match(body.error.message, /Set maxSatsPerPayment to 5000\./);
		assert.doesNotMatch(body.error.message, /--max-sats/);
	} finally {
		await bridge.close();
		await seller.close();
	}
});
