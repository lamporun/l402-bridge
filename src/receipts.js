// @ts-check
// Receipt checking. A seller that publishes /.well-known/l402-receipts.json
// signs a receipt for every debit of a bundle (see l402-receipts). After each
// answer the bridge fetches the new receipts with the bundle's own
// credential and checks them: signature, an unbroken history from the last
// receipt it verified, the balance arithmetic, each debit recomputed from its
// usage and rates, and that one of them reports the usage the answer itself
// reported. Problems are logged and shown in /l402/status; checking never
// delays or blocks an answer.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Transform } from "node:stream";
import { checkChain, parseCredential } from "l402-receipts";

/** @typedef {import("l402-receipts").Receipt} Receipt */

/**
 * @typedef {object} ObservedUsage
 * @property {number} prompt
 * @property {number} cached
 * @property {number} completion
 */

const TAIL_BYTES = 256 * 1024;

/**
 * usageTap passes a response through unchanged and keeps its tail, where the
 * usage object of a JSON body or of the last stream chunk is.
 */
export function usageTap() {
	/** @type {Buffer[]} */
	let chunks = [];
	let size = 0;
	const tap = new Transform({
		transform(chunk, _enc, done) {
			chunks.push(chunk);
			size += chunk.length;
			while (size - chunks[0].length >= TAIL_BYTES) {
				size -= chunks[0].length;
				chunks.shift();
			}
			done(null, chunk);
		},
	});
	return {
		tap,
		/** @returns {ObservedUsage | null} */
		usage() {
			const usage = parseUsage(Buffer.concat(chunks).toString("utf8"));
			chunks = [];
			return usage;
		},
	};
}

/**
 * parseUsage reads the OpenAI usage object of a JSON body or of the last
 * stream chunk that carries one.
 *
 * @param {string} text
 * @returns {ObservedUsage | null}
 */
export function parseUsage(text) {
	/** @param {any} u */
	const pick = (u) =>
		u && Number.isSafeInteger(u.prompt_tokens) && Number.isSafeInteger(u.completion_tokens)
			? {
					prompt: u.prompt_tokens,
					completion: u.completion_tokens,
					cached: Math.min(Math.max(Number(u.prompt_tokens_details?.cached_tokens) || 0, 0), u.prompt_tokens),
				}
			: null;
	try {
		const whole = pick(JSON.parse(text)?.usage);
		if (whole) return whole;
	} catch {
		// Not a single JSON body: a stream.
	}
	/** @type {ObservedUsage | null} */
	let last = null;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("data:")) continue;
		try {
			last = pick(JSON.parse(t.slice(5))?.usage) ?? last;
		} catch {
			// [DONE], or a chunk cut by the tail.
		}
	}
	return last;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ReceiptChecker {
	/**
	 * @param {object} o
	 * @param {string} o.sellerOrigin
	 * @param {typeof fetch} o.fetchFn
	 * @param {string} o.file where verified receipts are kept
	 * @param {(line: string) => void} o.log
	 * @param {number[]} [o.retryMs] waits before each fetch, since the seller
	 *   books a debit just after the answer ends
	 */
	constructor({ sellerOrigin, fetchFn, file, log, retryMs = [400, 1500, 4000] }) {
		this.sellerOrigin = sellerOrigin;
		this.fetchFn = fetchFn;
		this.file = file;
		this.log = log;
		this.retryMs = retryMs;
		/** @type {{ issuer: string | null, tokens: Record<string, { last: Receipt, verified: number }>, problems: { at: string, problem: string }[] }} */
		this.state = { issuer: null, tokens: {}, problems: [] };
		try {
			const saved = JSON.parse(readFileSync(file, "utf8"));
			if (saved && typeof saved === "object" && saved.tokens) this.state = { problems: [], ...saved };
		} catch {
			// First run.
		}
		/** @type {Promise<{ issuer: string, receipts: string } | null> | null} */
		this.discovery = null;
		/** @type {Map<string, Promise<void>>} */
		this.queues = new Map();
	}

	save() {
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
		renameSync(tmp, this.file);
	}

	/** @param {string} problem */
	problem(problem) {
		this.state.problems = [{ at: new Date().toISOString(), problem }, ...this.state.problems].slice(0, 20);
		this.log(`⚠ receipts: ${problem}`);
	}

	/** The seller's receipt service, or null when it has none. */
	discover() {
		this.discovery ??= (async () => {
			try {
				const res = await this.fetchFn(`${this.sellerOrigin}/.well-known/l402-receipts.json`, {
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				});
				if (!res.ok) return null;
				const wk = await res.json();
				const receipts = new URL(String(wk.receipts));
				if (receipts.origin !== this.sellerOrigin || !/^[0-9a-f]{64}$/.test(String(wk.issuer))) return null;
				if (this.state.issuer && this.state.issuer !== wk.issuer) {
					this.problem(`the seller's receipt key changed from ${this.state.issuer} to ${wk.issuer}`);
					return null;
				}
				if (!this.state.issuer) {
					this.state.issuer = wk.issuer;
					this.save();
				}
				return { issuer: wk.issuer, receipts: receipts.href };
			} catch {
				return null;
			}
		})();
		return this.discovery;
	}

	/**
	 * Checks the receipts behind one answer. Never throws; one check per
	 * bundle runs at a time.
	 *
	 * @param {string} model
	 * @param {{ macaroonB64: string, preimageHex: string }} token
	 * @param {ObservedUsage | null} observed
	 */
	afterAnswer(model, token, observed) {
		const header = `L402 ${token.macaroonB64}:${token.preimageHex}`;
		let tokenId;
		try {
			tokenId = parseCredential(header).token;
		} catch {
			return Promise.resolve();
		}
		const run = (this.queues.get(tokenId) ?? Promise.resolve())
			.then(() => this.check(model, header, tokenId, observed))
			.catch((err) => this.log(`⚠ receipts: ${err instanceof Error ? err.message : String(err)}`));
		this.queues.set(tokenId, run);
		void run.then(() => {
			if (this.queues.get(tokenId) === run) this.queues.delete(tokenId);
		});
		return run;
	}

	/**
	 * @param {string} model
	 * @param {string} header
	 * @param {string} tokenId
	 * @param {ObservedUsage | null} observed
	 */
	async check(model, header, tokenId, observed) {
		const service = await this.discover();
		if (!service) return;
		const known = this.state.tokens[tokenId];
		const after = known ? known.last.seq : 0;

		/** @type {Receipt[]} */
		let fresh = [];
		for (const wait of this.retryMs) {
			await sleep(wait);
			const res = await this.fetchFn(`${service.receipts}?after=${after}`, {
				headers: { authorization: header },
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
			if (res.status === 404 && !known) return; // a bundle from before receipts
			if (!res.ok) continue;
			const body = await res.json();
			fresh = Array.isArray(body.receipts) ? body.receipts : [];
			const matched = !observed || fresh.some((r) => sameUsage(r, observed));
			if (fresh.length && matched) break;
		}
		if (!fresh.length) {
			if (observed) this.problem(`${model}: no receipt arrived for an answer that used ${observed.prompt} + ${observed.completion} tokens`);
			return;
		}

		const cred = parseCredential(header);
		const report = checkChain(fresh, { issuer: service.issuer, credential: cred, previous: known?.last });
		for (const p of report.problems) this.problem(`${model}: ${p}`);
		if (observed && !fresh.some((r) => sameUsage(r, observed))) {
			this.problem(`${model}: no receipt reports the usage of the answer (${observed.prompt} prompt, ${observed.cached} cached, ${observed.completion} completion tokens)`);
		}
		if (!report.ok) return;

		const last = fresh[fresh.length - 1];
		this.state.tokens[tokenId] = { last, verified: (known?.verified ?? 0) + fresh.length };
		this.save();
		const n = (/** @type {number} */ x) => x.toLocaleString("en-US");
		for (const r of fresh) {
			const u = r.usage;
			const what = r.source === "split" && u ? `${n(u.prompt ?? 0)} + ${n(u.completion ?? 0)} tokens${u.cached ? ` (${n(u.cached)} cached)` : ""}` : r.source;
			this.log(`🧾 ${model}: receipt ${r.seq} ✓ ${what} → ${n(r.debit)} debited, ${n(r.remaining)} left`);
		}
	}

	status() {
		const tokens = Object.values(this.state.tokens);
		return {
			issuer: this.state.issuer,
			verified: tokens.reduce((s, t) => s + t.verified, 0),
			bundles: tokens.map((t) => ({ model: t.last.model, receipts: t.last.seq, remaining_tokens: t.last.remaining })),
			problems: this.state.problems,
		};
	}
}

/**
 * @param {Receipt} r
 * @param {ObservedUsage} u
 */
function sameUsage(r, u) {
	return r.source === "split" && r.usage?.prompt === u.prompt && r.usage?.completion === u.completion && (r.usage?.cached ?? 0) === u.cached;
}
