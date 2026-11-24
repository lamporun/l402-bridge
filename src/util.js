// @ts-check
// Small helpers shared by the bridge: invoice decoding, hashing and number
// formatting.

import { createHash } from "node:crypto";
import { decode } from "light-bolt11-decoder";

/**
 * decodeInvoice extracts what the bridge checks before and after paying: the
 * payment hash, which the preimage must hash to, and the amount.
 *
 * @param {string} invoice a BOLT11 payment request
 * @returns {{ paymentHash: string, amountSat: number | null }} amountSat is
 *   rounded up to whole sats, and null for an amountless invoice
 */
export function decodeInvoice(invoice) {
	const { sections } = decode(invoice);
	/**
	 * @param {string} name
	 * @returns {{ name: string, value?: unknown } | undefined}
	 */
	const section = (name) => sections.find((s) => s.name === name);
	const hash = section("payment_hash");
	if (!hash || typeof hash.value !== "string" || !/^[0-9a-f]{64}$/i.test(hash.value)) {
		throw new Error("invoice has no payment hash");
	}
	const amount = section("amount");
	let amountSat = null;
	if (amount && typeof amount.value === "string" && /^\d+$/.test(amount.value)) {
		amountSat = Number((BigInt(amount.value) + 999n) / 1000n);
	}
	return { paymentHash: hash.value.toLowerCase(), amountSat };
}

/**
 * sha256Hex hashes hex-encoded bytes and returns the digest as hex.
 *
 * @param {string} hex
 */
export function sha256Hex(hex) {
	return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

/**
 * formatSat renders a sat amount with thousands separators.
 *
 * @param {number} sats
 */
export function formatSat(sats) {
	return Math.round(sats).toLocaleString("en-US");
}

/**
 * localDayStart is the start of the local calendar day containing now, in ms.
 *
 * @param {number} now
 */
export function localDayStart(now) {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}
