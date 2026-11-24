// @ts-check
// The model list a tool shows. Most tools ask GET /v1/models before they send
// anything. A seller that serves the list for free is passed through; for one
// that puts it behind the paywall, the bridge builds the list from the
// seller's rate file (<origin>/pi402.json, the file pi-402 reads), so a tool
// can list models without paying for the list.

const MAX_MENU_BYTES = 256 * 1024;
const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/**
 * menuToModels turns a rate file body into an OpenAI model list, or returns
 * null if it has no usable entry.
 *
 * @param {unknown} body
 */
export function menuToModels(body) {
	const file = /** @type {{ version?: unknown, models?: unknown } | null} */ (body);
	if (!file || typeof file !== "object" || file.version !== 1) {
		return null;
	}
	const entries = file.models;
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
		return null;
	}
	const data = [];
	for (const [id, raw] of Object.entries(entries)) {
		if (!WIRE_ID.test(id) || !raw || typeof raw !== "object") {
			continue;
		}
		const entry = /** @type {Record<string, unknown>} */ (raw);
		data.push({
			id,
			object: "model",
			owned_by: id.includes("/") ? id.slice(0, id.indexOf("/")) : "seller",
			...(typeof entry.name === "string" ? { name: entry.name.slice(0, 80) } : {}),
			...(typeof entry.contextTokens === "number" ? { context_length: entry.contextTokens } : {}),
		});
	}
	return data.length > 0 ? { object: /** @type {const} */ ("list"), data } : null;
}

/**
 * fetchJson fetches a small JSON document without credentials, bounded in
 * time and size. It resolves to null on any failure.
 *
 * @param {string} url
 * @param {typeof fetch} fetchFn
 * @param {number} [timeoutMs]
 */
export async function fetchJson(url, fetchFn, timeoutMs = 10_000) {
	try {
		const res = await fetchFn(url, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { accept: "application/json" },
			redirect: "error",
		});
		if (!res.ok) {
			return null;
		}
		const text = await res.text();
		if (text.length > MAX_MENU_BYTES * 4) {
			return null;
		}
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * loadModels returns the seller's model list: its own /models when that is
 * free and well formed, otherwise one built from its rate file.
 *
 * @param {{ sellerBase: string, sellerOrigin: string, fetchFn: typeof fetch }} options
 * @returns {Promise<{ object: "list", data: Array<Record<string, unknown>> } | null>}
 */
export async function loadModels({ sellerBase, sellerOrigin, fetchFn }) {
	const own = await fetchJson(`${sellerBase}/models`, fetchFn);
	if (own && typeof own === "object" && Array.isArray(own.data)) {
		const data = own.data.filter(
			(/** @type {unknown} */ m) =>
				m && typeof m === "object" && typeof (/** @type {{ id?: unknown }} */ (m).id) === "string",
		);
		if (data.length > 0) {
			return { ...own, object: "list", data };
		}
	}
	return menuToModels(await fetchJson(`${sellerOrigin}/pi402.json`, fetchFn));
}
