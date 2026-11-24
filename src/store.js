// @ts-check
// Durable state: paid L402 tokens and the payment ledger. Both live under the
// data directory with owner-only permissions. A token is a live bearer
// credential for the unspent part of a bundle (macaroon plus preimage), and
// the ledger holds proofs of payment.
//
// The token store follows the TokenStore contract of
// @lightninglabs/aperture-client, and its shape is adapted from pi-402's
// FileTokenStore (MIT, Lightning Labs).

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @typedef {{ macaroonB64: string, preimageHex: string, expiresAt: string }} CachedToken
 */

/**
 * ensurePrivateDir creates the directory with owner-only permissions.
 *
 * @param {string} dir
 */
export function ensurePrivateDir(dir) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * writePrivateFile replaces a file atomically, readable by the owner only.
 *
 * @param {string} path
 * @param {string} content
 */
function writePrivateFile(path, content) {
	ensurePrivateDir(dirname(path));
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, { mode: 0o600 });
	renameSync(tmp, path);
}

/**
 * isExpired reports whether a token is past its expiry. An empty expiry means
 * the challenge carried none; an unparseable one counts as expired.
 *
 * @param {CachedToken} token
 */
function isExpired(token) {
	if (!token.expiresAt) {
		return false;
	}
	const ms = new Date(token.expiresAt).getTime();
	return Number.isNaN(ms) || Date.now() > ms;
}

/**
 * isToken checks the shape of a stored token.
 *
 * @param {unknown} value
 * @returns {value is CachedToken}
 */
function isToken(value) {
	if (!value || typeof value !== "object") {
		return false;
	}
	const token = /** @type {Record<string, unknown>} */ (value);
	return (
		typeof token.macaroonB64 === "string" &&
		typeof token.preimageHex === "string" &&
		typeof token.expiresAt === "string"
	);
}

/** FileTokenStore keeps paid L402 tokens in a JSON file. */
export class FileTokenStore {
	/** @param {string} path */
	constructor(path) {
		this.path = path;
	}

	/**
	 * read loads the file fresh. A missing file is empty. A corrupt one is set
	 * aside and read as empty: the worst case is buying a bundle again.
	 *
	 * @returns {Map<string, CachedToken>}
	 */
	read() {
		let raw;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (err) {
			if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
				return new Map();
			}
			throw err;
		}
		try {
			const state = JSON.parse(raw);
			/** @type {Map<string, CachedToken>} */
			const tokens = new Map();
			for (const [key, token] of Object.entries(state?.tokens ?? {})) {
				if (isToken(token) && !isExpired(token)) {
					tokens.set(key, token);
				}
			}
			return tokens;
		} catch {
			console.warn(`l402-bridge: token store ${this.path} is corrupt, setting it aside`);
			try {
				renameSync(this.path, `${this.path}.${Date.now()}.corrupt`);
			} catch {
				// Already set aside.
			}
			return new Map();
		}
	}

	/**
	 * @param {string} key
	 * @returns {CachedToken | null}
	 */
	get(key) {
		try {
			return this.read().get(key) ?? null;
		} catch (err) {
			// An unreadable store must not block a request; it only means
			// a bundle may be bought again.
			console.warn(`l402-bridge: token store ${this.path} is unreadable:`, err);
			return null;
		}
	}

	/**
	 * put merges the token into the file, so tokens written by another
	 * process since the last read survive.
	 *
	 * @param {string} key
	 * @param {CachedToken} token
	 */
	put(key, token) {
		const tokens = this.read();
		tokens.set(key, token);
		writePrivateFile(this.path, JSON.stringify({ version: 1, tokens: Object.fromEntries(tokens) }));
	}

	/** entries lists the live tokens with their keys. */
	entries() {
		try {
			return [...this.read().entries()];
		} catch {
			return [];
		}
	}
}

/**
 * @typedef {{
 *   ts: string,
 *   seller: string,
 *   model: string,
 *   amountSat: number,
 *   feesSat: number,
 *   paymentHash: string,
 *   preimageHex: string,
 *   preimageOk: boolean,
 * }} Payment
 */

/**
 * Ledger is the append-only record of every payment the wallet made,
 * including ones whose credential turned out unusable: money that moved is
 * always counted against the daily limit.
 */
export class Ledger {
	/** @param {string} path */
	constructor(path) {
		this.path = path;
		/** @type {Payment[]} */
		this.payments = [];
		try {
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (!line.trim()) {
					continue;
				}
				try {
					const entry = JSON.parse(line);
					if (entry && typeof entry.amountSat === "number" && typeof entry.ts === "string") {
						this.payments.push(entry);
					}
				} catch {
					// A torn last line from a crash; the rest is intact.
				}
			}
		} catch (err) {
			if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") {
				throw err;
			}
		}
	}

	/** @param {Payment} payment */
	append(payment) {
		ensurePrivateDir(dirname(this.path));
		appendFileSync(this.path, `${JSON.stringify(payment)}\n`, { mode: 0o600 });
		chmodSync(this.path, 0o600);
		this.payments.push(payment);
	}

	/**
	 * spentSince sums what payments since the given time cost, fees included.
	 *
	 * @param {number} sinceMs
	 */
	spentSince(sinceMs) {
		let total = 0;
		for (const payment of this.payments) {
			if (new Date(payment.ts).getTime() >= sinceMs) {
				total += payment.amountSat + (payment.feesSat || 0);
			}
		}
		return total;
	}

	/**
	 * recent returns the latest payments, newest first, without preimages.
	 *
	 * @param {number} count
	 */
	recent(count) {
		return this.payments
			.slice(-count)
			.reverse()
			.map(({ preimageHex: _preimage, ...rest }) => rest);
	}
}
