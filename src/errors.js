// @ts-check
// Errors the bridge turns into OpenAI-shaped error responses, so a tool shows
// the user why a request was not paid for instead of a bare status code.

/** PolicyError is a payment the bridge refused to make. */
export class PolicyError extends Error {
	/**
	 * @param {string} message
	 * @param {string} code
	 */
	constructor(message, code) {
		super(message);
		this.name = "PolicyError";
		this.code = code;
	}
}

/**
 * WalletError is a payment the wallet did not make, or whose outcome is
 * unknown. uncertain marks the second case: the money may have moved.
 */
export class WalletError extends Error {
	/**
	 * @param {string} message
	 * @param {{ uncertain?: boolean, cause?: unknown }} [options]
	 */
	constructor(message, options = {}) {
		super(message, { cause: options.cause });
		this.name = "WalletError";
		this.uncertain = options.uncertain === true;
	}
}
