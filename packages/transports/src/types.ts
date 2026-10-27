// Shared pieces for the transport implementations.
//
// The one thing every "direct" transport has to have an opinion about: a handful of
// request headers are owned by the browser's network stack, not by JavaScript. Fetch
// silently drops them. `proxy-transports` still hands them to `request()`, so this
// module names them and the transports decide what to do (drop, or pass them through
// and let the host — a browser extension, usually — rewrite them out of band).

/**
 * Request headers the Fetch API refuses to let JavaScript set (the Fetch spec's
 * "forbidden header names", plus the three the browser always computes).
 *
 * Names are compared lowercased.
 */
export const STACK_OWNED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
	"accept-charset",
	"accept-encoding",
	"access-control-request-headers",
	"access-control-request-method",
	"connection",
	"content-length",
	"cookie",
	"cookie2",
	"date",
	"dnt",
	"expect",
	"host",
	"keep-alive",
	"origin",
	"referer",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"via",
]);

/** Response headers the Fetch API hides from JavaScript (needed to keep a cookie jar). */
export const STACK_HIDDEN_RESPONSE_HEADERS: ReadonlySet<string> = new Set(["set-cookie", "set-cookie2"]);

/**
 * `Headers.getSetCookie()` is the only way to see more than one `Set-Cookie`. It is
 * Young Enough that the fallback is worth keeping.
 */
export function readSetCookie(headers: Headers): string[] {
	if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
	const one = headers.get("set-cookie");
	return one ? [one] : [];
}

/** Response headers as `proxy-transports` wants them, with `Set-Cookie` kept separate. */
export function rawResponseHeaders(headers: Headers): [string, string][] {
	const out: [string, string][] = [];
	for (const [name, value] of headers) {
		if (STACK_HIDDEN_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
		out.push([name, value]);
	}
	for (const value of readSetCookie(headers)) out.push(["set-cookie", value]);
	return out;
}

export type LogLevel = "info" | "warn" | "error";

export type Notice = (level: LogLevel, message: string) => void;

/** Redirect status codes that a `Location` header turns into a followable redirect. */
export const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export function isRedirect(status: number): boolean {
	return REDIRECT_STATUS.has(status);
}

/** Bodies are replayed on a redirect only for methods that keep their body. */
export function bodyAfterRedirect(status: number, method: string, url: URL, location: string | null) {
	const next = location ? new URL(location, url) : url;
	const dropBody = status === 303 || ((status === 301 || status === 302) && method.toUpperCase() === "POST");
	return { url: next, method: dropBody ? "GET" : method, dropBody };
}
