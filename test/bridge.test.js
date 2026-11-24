// @ts-check
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import OpenAI from "openai";
import { fakeWallet, startBridge, startSeller } from "./helpers.js";

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
	for (const close of cleanups.reverse()) {
		await close();
	}
	cleanups = [];
});

/**
 * setup starts a seller and a bridge in front of it.
 *
 * @param {Parameters<typeof startSeller>[0]} [sellerOptions]
 * @param {Partial<Parameters<typeof startBridge>[0]> & { walletMode?: Parameters<typeof fakeWallet>[1] }} [bridgeOptions]
 */
async function setup(sellerOptions, bridgeOptions = {}) {
	const seller = await startSeller(sellerOptions);
	const wallet = fakeWallet(seller.preimages, bridgeOptions.walletMode);
	const bridge = await startBridge({ sellerBase: seller.base, wallet, ...bridgeOptions });
	cleanups.push(seller.close, bridge.close);
	const client = new OpenAI({ baseURL: bridge.base, apiKey: bridgeOptions.accessKey ?? "sk-not-a-real-key", maxRetries: 0 });
	return { seller, wallet, bridge, client };
}

/**
 * post sends a raw chat completion request to the bridge.
 *
 * @param {string} base
 * @param {Record<string, string>} [headers]
 * @param {string} [body]
 */
function post(base, headers = {}, body = JSON.stringify({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }] })) {
	return fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

test("a tool streams a paid completion; the second request reuses the bundle", async () => {
	const { seller, wallet, bridge, client } = await setup();

	const stream = await client.chat.completions.create({
		model: "acme/Fast-1",
		messages: [{ role: "user", content: "hi" }],
		stream: true,
	});
	let text = "";
	for await (const chunk of stream) {
		text += chunk.choices[0]?.delta?.content ?? "";
	}
	assert.equal(text, "paid in sats");

	const second = await client.chat.completions.create({ model: "acme/Fast-1", messages: [{ role: "user", content: "again" }] });
	assert.equal(second.choices[0].message.content, "paid in sats");

	assert.equal(wallet.paid.length, 1, "one bundle bought");
	assert.equal(seller.seen.paid, 2, "two requests served");
	assert.equal(bridge.ledger.payments.length, 1);
	assert.equal(bridge.ledger.payments[0].model, "acme/Fast-1");
	assert.equal(bridge.ledger.payments[0].preimageOk, true);

	// The tool's own API key never reaches the seller.
	assert.ok(seller.seen.authorizations.every((a) => a === "" || a.startsWith("L402 ")));
	assert.ok(!seller.seen.authorizations.some((a) => a.includes("sk-not-a-real-key")));

	// Paid tokens and the payment log are private files.
	for (const file of ["tokens.json", "payments.ndjson"]) {
		assert.equal(statSync(join(bridge.dataDir, file)).mode & 0o777, 0o600, file);
	}
});

test("requests fired at once for a new model buy one bundle", async () => {
	const { wallet, seller, client } = await setup();
	const ask = () => client.chat.completions.create({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }] });
	const answers = await Promise.all([ask(), ask(), ask(), ask()]);
	assert.equal(answers.length, 4);
	assert.equal(wallet.paid.length, 1);
	assert.equal(seller.seen.paid, 4);
});

test("each model has its own bundle, and an exhausted bundle is replaced", async () => {
	const { wallet, client } = await setup({ bundleRequests: 1 });
	const ask = (/** @type {string} */ model) => client.chat.completions.create({ model, messages: [{ role: "user", content: "hi" }] });
	await ask("acme/Fast-1");
	await ask("acme/Other-2");
	assert.equal(wallet.paid.length, 2, "one bundle per model");
	await ask("acme/Fast-1");
	assert.equal(wallet.paid.length, 3, "the used-up bundle was bought again");
});

test("a bundle above the per-payment limit is refused with a clear message", async () => {
	const { wallet, bridge } = await setup({ priceSats: 3_000 });
	const res = await post(bridge.base);
	assert.equal(res.status, 402);
	const body = await res.json();
	assert.equal(body.error.type, "l402_bridge_limit");
	assert.match(body.error.message, /3,000 sats, above the limit of 1,000 sats per payment/);
	assert.match(body.error.message, /--max-sats-per-payment 3000/);
	assert.equal(wallet.paid.length, 0);
	assert.equal(bridge.ledger.payments.length, 0);
});

test("the daily limit counts what was already spent today", async () => {
	const { wallet, client } = await setup({}, { maxSatsPerDay: 1_500 });
	await client.chat.completions.create({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }] });
	await assert.rejects(
		client.chat.completions.create({ model: "acme/Other-2", messages: [{ role: "user", content: "hi" }] }),
		(err) => {
			assert.equal(/** @type {any} */ (err).status, 402);
			assert.match(String(/** @type {any} */ (err).message), /today's limit of 1,500 sats/);
			return true;
		},
	);
	assert.equal(wallet.paid.length, 1);
});

test("a wallet without enough sats fails the request and records nothing", async () => {
	const { bridge } = await setup({}, { walletMode: { mode: "insufficient" } });
	const res = await post(bridge.base);
	assert.equal(res.status, 502);
	assert.match((await res.json()).error.message, /does not have enough sats/);
	assert.equal(bridge.ledger.payments.length, 0);
	assert.equal(bridge.guard.spentToday(), 0);
});

test("a payment whose reply times out is looked up instead of paid again", async () => {
	const { wallet, bridge, seller } = await setup({}, { walletMode: { mode: "timeout-then-settled" } });
	const res = await post(bridge.base);
	assert.equal(res.status, 200);
	assert.equal(wallet.paid.length, 1);
	assert.equal(seller.seen.challenges, 1);
	assert.equal(bridge.ledger.payments.length, 1);
});

test("a payment whose outcome stays unknown pauses further payments", async () => {
	const { wallet, bridge } = await setup({}, { walletMode: { mode: "timeout-unknown" } });
	const first = await post(bridge.base);
	assert.equal(first.status, 502);
	assert.match((await first.json()).error.message, /did not confirm whether the payment went through/);

	const second = await post(bridge.base, {}, JSON.stringify({ model: "acme/Other-2", messages: [] }));
	assert.equal(second.status, 402);
	assert.match((await second.json()).error.message, /payments are paused/);
	assert.equal(wallet.paid.length, 1, "no second payment while the first is unresolved");
});

test("a preimage that does not match is recorded as spent and fails the request", async () => {
	const { bridge } = await setup({}, { walletMode: { mode: "wrong-preimage" } });
	const res = await post(bridge.base);
	assert.equal(res.status, 502);
	assert.match((await res.json()).error.message, /preimage that does not match/);
	assert.equal(bridge.ledger.payments.length, 1);
	assert.equal(bridge.ledger.payments[0].preimageOk, false);
	assert.equal(bridge.guard.spentToday(), 1_000, "money that moved counts against the limit");
});

test("routing fees count against the daily limit", async () => {
	const { client, bridge } = await setup({}, { walletMode: { feesMsat: 3_500 } });
	await client.chat.completions.create({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }] });
	assert.equal(bridge.ledger.payments[0].feesSat, 4);
	assert.equal(bridge.guard.spentToday(), 1_004);
});

test("a web page cannot use the bridge: foreign Host and browser Origin are refused", async () => {
	const { bridge, wallet } = await setup();

	// DNS rebinding: the page's own host name pointed at 127.0.0.1.
	const rebinding = await new Promise((resolve, reject) => {
		import("node:http").then(({ request }) => {
			const req = request(
				{ host: "127.0.0.1", port: bridge.port, path: "/v1/chat/completions", method: "POST", headers: { host: "evil.example", "content-type": "application/json" } },
				(res) => resolve(res.statusCode),
			);
			req.on("error", reject);
			req.end(JSON.stringify({ model: "acme/Fast-1", messages: [] }));
		});
	});
	assert.equal(rebinding, 403);

	const browser = await post(bridge.base, { origin: "https://evil.example" });
	assert.equal(browser.status, 403);
	assert.equal(wallet.paid.length, 0);
});

test("an allowed browser origin gets CORS headers", async () => {
	const { bridge } = await setup({}, { allowedOrigins: ["http://localhost:3000"] });
	const preflight = await fetch(`${bridge.base}/chat/completions`, {
		method: "OPTIONS",
		headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
	});
	assert.equal(preflight.status, 204);
	assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:3000");
	const res = await post(bridge.base, { origin: "http://localhost:3000" });
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

test("with an access key, requests without it are refused", async () => {
	const key = "a-long-local-access-key";
	const { bridge, client, wallet } = await setup({}, { accessKey: key });
	assert.equal((await post(bridge.base)).status, 401);
	assert.equal((await post(bridge.base, { authorization: "Bearer wrong-key-of-some-length" })).status, 401);
	const ok = await client.chat.completions.create({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }] });
	assert.equal(ok.choices[0].message.content, "paid in sats");
	assert.equal(wallet.paid.length, 1);
});

test("the model list comes from the seller, or from its rate file when the list is paywalled", async () => {
	const paywalled = await setup();
	const fromMenu = await paywalled.client.models.list();
	assert.deepEqual(
		fromMenu.data.map((m) => m.id),
		["acme/Fast-1"],
	);
	assert.equal(paywalled.wallet.paid.length, 0, "listing models never pays");

	const free = await setup({ freeModels: true });
	const listed = await free.client.models.list();
	assert.deepEqual(
		listed.data.map((m) => m.id),
		["acme/Listed"],
	);
});

test("the status page shows limits, bundles and payments without secrets", async () => {
	const { bridge, client } = await setup();
	await client.chat.completions.create({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }] });
	const status = await (await fetch(`${bridge.origin}/l402/status`)).json();
	assert.equal(status.limits.spent_today_sats, 1_000);
	assert.equal(status.wallet.balance_sats, 21_000);
	assert.deepEqual(status.bundles, [{ model: "acme/Fast-1", remaining_tokens: 99_000, bundle_tokens: 100_000, activated: true }]);
	assert.equal(status.recent_payments.length, 1);
	const raw = JSON.stringify(status);
	assert.ok(!raw.includes("preimage\":\"") && !raw.includes("macaroon"), "no preimages or macaroons");
});

test("malformed requests are rejected before anything is paid", async () => {
	const { bridge, wallet } = await setup();
	assert.equal((await post(bridge.base, { "content-type": "text/plain" })).status, 415);
	assert.equal((await post(bridge.base, {}, "{nope")).status, 400);
	assert.equal((await post(bridge.base, {}, JSON.stringify({ messages: [] }))).status, 400);
	assert.equal((await fetch(`${bridge.base}/files`, { method: "POST" })).status, 404);
	assert.equal(wallet.paid.length, 0);
});
