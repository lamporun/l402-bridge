// @ts-check
// End-to-end check over a real Nostr relay: a throwaway NWC wallet service
// (NIP-47, encrypted, through wss://relay.getalby.com/v1) pays a local fake
// seller's invoices, and the real l402-bridge CLI sits in between, driven by
// the openai SDK. No real sats move: the wallet "pays" by returning the fake
// seller's preimage. Run: node dev/e2e-nwc.js
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NWCWalletService, NWCWalletServiceKeyPair } from "@getalby/sdk/nwc";
import bolt11 from "bolt11";
import { getPublicKey } from "nostr-tools";
import OpenAI from "openai";
import { startSeller } from "../test/helpers.js";

const RELAY = process.env.RELAY ?? "wss://relay.getalby.com/v1";
const seller = await startSeller();

const walletSecret = randomBytes(32).toString("hex");
const clientSecret = randomBytes(32);
const clientPubkey = getPublicKey(clientSecret);
const keypair = new NWCWalletServiceKeyPair(walletSecret, clientPubkey);
const service = new NWCWalletService({ relayUrls: [RELAY] });
const methods = /** @type {const} */ (["get_info", "get_balance", "pay_invoice", "lookup_invoice"]);
await service.publishWalletServiceInfoEvent(walletSecret, [...methods], []);
let payments = 0;
await service.subscribe(keypair, {
	getInfo: async () => ({
		result: { alias: "e2e wallet", color: "", pubkey: "", network: "mainnet", block_height: 0, block_hash: "", methods: [...methods] },
		error: undefined,
	}),
	getBalance: async () => ({ result: { balance: 21_000_000 }, error: undefined }),
	payInvoice: async ({ invoice }) => {
		payments++;
		const hash = /** @type {string} */ (bolt11.decode(invoice).tags.find((t) => t.tagName === "payment_hash")?.data);
		return { result: { preimage: /** @type {string} */ (seller.preimages.get(hash)), fees_paid: 1_000 }, error: undefined };
	},
});
const walletUrl = `nostr+walletconnect://${keypair.walletPubkey}?relay=${encodeURIComponent(RELAY)}&secret=${clientSecret.toString("hex")}`;

const port = 18_000 + Math.floor(Math.random() * 1_000);
const bridge = spawn(
	process.execPath,
	["bin/l402-bridge.js", "--seller", seller.base, "--port", String(port), "--data-dir", mkdtempSync(join(tmpdir(), "l402-e2e-"))],
	{ env: { ...process.env, NWC_URL: walletUrl }, stdio: ["ignore", "pipe", "inherit"] },
);
let output = "";
bridge.stdout.on("data", (chunk) => {
	output += chunk;
	process.stdout.write(chunk);
});
const deadline = Date.now() + 60_000;
while (!output.includes("is ready") && Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 200));
}
if (!output.includes("is ready")) {
	throw new Error("bridge did not start");
}

const client = new OpenAI({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "anything", maxRetries: 0 });
let ok = true;
try {
	const listed = await client.models.list();
	console.log("models:", listed.data.map((m) => m.id).join(", "));
	const stream = await client.chat.completions.create({ model: "acme/Fast-1", messages: [{ role: "user", content: "hi" }], stream: true });
	let text = "";
	for await (const chunk of stream) {
		text += chunk.choices[0]?.delta?.content ?? "";
	}
	console.log("stream:", JSON.stringify(text));
	const again = await client.chat.completions.create({ model: "acme/Fast-1", messages: [{ role: "user", content: "again" }] });
	console.log("second:", JSON.stringify(again.choices[0].message.content));
	const status = await (await fetch(`http://127.0.0.1:${port}/l402/status`)).json();
	console.log("status:", JSON.stringify({ wallet: status.wallet, limits: status.limits, bundles: status.bundles }));
	ok = text === "paid in sats" && payments === 1 && status.limits.spent_today_sats === 1_001;
} catch (err) {
	ok = false;
	console.error(err);
} finally {
	bridge.kill("SIGTERM");
	service.close();
	await seller.close();
}
console.log(ok ? "E2E OK: one NWC payment over the relay, two completions" : `E2E FAILED (payments=${payments})`);
process.exit(ok ? 0 : 1);
