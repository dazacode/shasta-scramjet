// Things only a browser extension can do for a direct transport.
//
// A plain page cannot see `Set-Cookie` and cannot make the browser send a cookie that is
// not in the browser's own jar. Scramjet keeps its own jar (it has to: the sandboxed page
// reads `document.cookie` through the rewriter, not through the browser). So in direct
// mode the two jars disagree and logins break.
//
// The bridge here reconciles them, and does nothing at all when it is not in an extension.
//
//   push:   before a request, write the host's cookies for that URL into the browser's jar,
//           so the wire carries them.
//   capture: read `Set-Cookie` back off the response and hand it to the host.
//
// Requires `permissions: ["cookies", "webRequest"]` and `host_permissions: ["<all_urls>"]`.
// MV3 `webRequest` is observation-only (blocking is policy-install-only) — which is all
// this needs.

export type ExtensionCookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: "no_restriction" | "lax" | "strict" | "unspecified";
	/** seconds since epoch */
	expirationDate?: number;
};

/** The host's cookie jar, in the two directions the bridge needs it. */
export interface CookieStore {
	/** Every cookie that would be sent to `url`. */
	forUrl(url: URL): ExtensionCookie[];
	/** One `Set-Cookie` line the site just sent. */
	setFromWire(rawSetCookie: string, url: URL): void;
}

export type CookieBridgeOptions = {
	/** Diagnostics. */
	onNotice?: (level: "info" | "warn", message: string) => void;
};

export type CookieBridge = {
	/** DirectTransport `onBeforeRequest`. */
	onBeforeRequest: (url: URL) => Promise<void>;
	/** DirectTransport `onResponseHeaders`. */
	onResponseHeaders: (url: URL, headers: [string, string][]) => void;
	stop: () => void;
};

// --- minimal ambient chrome types, so the package needs no @types/chrome ---------------

type ChromeHeader = { name: string; value?: string };

type ChromeDetails = {
	url: string;
	responseHeaders?: ChromeHeader[];
};

type ChromeEvent<T> = {
	addListener: (callback: (details: T) => void, filter: { urls: string[] }, extra: string[]) => void;
	removeListener: (callback: (details: T) => void) => void;
};

declare const chrome:
	| {
			runtime?: { id?: string };
			cookies: {
				set: (details: Record<string, unknown>) => Promise<unknown>;
				remove: (details: { url: string; name: string }) => Promise<unknown>;
			};
			webRequest: { onHeadersReceived: ChromeEvent<ChromeDetails> };
	  }
	| undefined;

export function isExtensionContext(): boolean {
	return typeof chrome !== "undefined" && typeof chrome?.runtime?.id === "string";
}

export function createCookieBridge(store: CookieStore, options: CookieBridgeOptions = {}): CookieBridge {
	if (!isExtensionContext()) {
		return { onBeforeRequest: () => Promise.resolve(), onResponseHeaders: () => {}, stop: () => {} };
	}

	/** URLs this transport is currently asking for: webRequest sees everything the extension loads. */
	const inFlight = new Set<string>();
	/** last value pushed per `origin\u0000name`, so an unchanged cookie is not rewritten every request. */
	const pushed = new Map<string, string>();

	const listener = (details: ChromeDetails) => {
		if (!inFlight.has(details.url)) return;
		for (const header of details.responseHeaders ?? []) {
			if (header.name.toLowerCase() !== "set-cookie" || header.value === undefined) continue;
			try {
				store.setFromWire(header.value, new URL(details.url));
			} catch (error) {
				options.onNotice?.("warn", `could not read a Set-Cookie header: ${String(error)}`);
			}
		}
	};
	chrome!.webRequest.onHeadersReceived.addListener(listener, { urls: ["<all_urls>"] }, ["responseHeaders", "extraHeaders"]);

	/**
	 * `Set-Cookie` from `fetch()` is unreliable across Chrome versions while webRequest always
	 * has it, so the capture direction lives on webRequest. The push direction cannot be done
	 * with headers at all (they are stack-owned), so it goes through the cookie API.
	 */
	const onBeforeRequest = async (url: URL) => {
		inFlight.add(url.href);
		for (const cookie of store.forUrl(url)) {
			const key = `${url.origin}\u0000${cookie.name}`;
			if (pushed.get(key) === cookie.value) continue;
			pushed.set(key, cookie.value);
			try {
				await chrome!.cookies.set({
					url: url.origin + (cookie.path || "/"),
					name: cookie.name,
					value: cookie.value,
					domain: cookie.domain || undefined,
					path: cookie.path || "/",
					secure: cookie.secure ?? url.protocol === "https:",
					httpOnly: cookie.httpOnly ?? false,
					sameSite: cookie.sameSite,
					expirationDate: cookie.expirationDate,
				});
			} catch (error) {
				pushed.delete(key);
				options.onNotice?.("warn", `could not push a cookie to the browser jar: ${String(error)}`);
			}
		}
	};

	return {
		onBeforeRequest,
		onResponseHeaders: (url, headers) => {
			inFlight.delete(url.href);
			// Belt and braces: take anything fetch() did expose, in case webRequest missed the hop.
			for (const [name, value] of headers) {
				if (name.toLowerCase() !== "set-cookie") continue;
				try {
					store.setFromWire(value, url);
				} catch {
					/* already reported by the listener */
				}
			}
		},
		stop: () => {
			chrome!.webRequest.onHeadersReceived.removeListener(listener);
			inFlight.clear();
			pushed.clear();
		},
	};
}

/**
 * What the running browser will actually let a direct transport do. Meant for the
 * settings/connection UI and for the experiments in FORK.md — not for deciding anything
 * at runtime.
 */
export function extensionCapabilities(): { extension: boolean; hostPermissions: boolean; rawCookies: boolean; stackHeaders: boolean } {
	const extension = isExtensionContext();
	return {
		extension,
		// `host_permissions: ["<all_urls>"]` removes CORS; there is no API to ask whether it is in effect.
		hostPermissions: extension,
		rawCookies: extension,
		// Needs declarativeNetRequest to rewrite Origin/Referer/Cookie; not wired up yet.
		stackHeaders: false,
	};
}
