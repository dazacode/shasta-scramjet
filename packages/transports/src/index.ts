// @shasta/transports — proxy-transports implementations for Scramjet.
//
// `DirectTransport`  uses the browser's own network. No relay.
// `HybridTransport`  uses it when it can and a Wisp relay when it cannot.
// `extension.ts`     the extension-only pieces a direct transport needs to keep cookies.
//
// Nothing here imports Scramjet: these are `@mercuryworkshop/proxy-transports` objects, so
// they work with any Scramjet build (and any other consumer of that interface).

export { DirectTransport, type DirectTransportOptions } from "./direct";
export { HybridTransport, type HybridTransportOptions } from "./hybrid";
export { createCookieBridge, extensionCapabilities, isExtensionContext, type CookieBridge, type CookieBridgeOptions, type CookieStore, type ExtensionCookie } from "./extension";
export {
	STACK_OWNED_REQUEST_HEADERS,
	STACK_HIDDEN_RESPONSE_HEADERS,
	isRedirect,
	readSetCookie,
	rawResponseHeaders,
	type LogLevel,
	type Notice,
} from "./types";
