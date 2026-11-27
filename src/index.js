// @ts-check
// l402-bridge as a library: start a bridge from a program (such as the
// OpenClaw plugin) instead of the command line.

export {
	ConfigError,
	DEFAULT_MAX_SATS_PER_DAY,
	DEFAULT_MAX_SATS_PER_PAYMENT,
	DEFAULT_PORT,
	DEFAULT_SELLER,
	resolveSettings,
	startBridge,
} from "./start.js";
export { PolicyError, WalletError } from "./errors.js";
export { CLI_HINTS } from "./policy.js";
export { loadModels, menuToModels } from "./menu.js";
