// A `ProxyTransport` that uses the browser's own network stack.
//
// Nothing here opens a socket to a relay: `request()` is `fetch()` and `connect()` is
// `new WebSocket()`. That is enough to browse a big part of the web with no server in
// the middle — but only where the browser lets you, which is the whole point of the
// class and the reason it is a transport and not a rewrite of anything.
//
// Known limits, stated up front (see FORK.md):
//   * `fetch()` from a plain page is CORS-checked: the target must send
//     `Access-Control-Allow-Origin` or the request fails. From a `chrome-extension://`
//     page with the matching `host_permissions`, CORS does not apply at all.
//   * Headers the stack owns (Cookie, Origin, Referer, Host, Accept-Encoding, …) cannot
//     be set. `setStackOwnedHeaders` passes them through anyway so a host that can
//     rewrite them (an extension, via DNR) gets them; otherwise they are dropped.
//   * No raw TCP. Only http(s) and ws(s), which is all Scramjet asks for.
//   * The browser follows its own cookie jar for the target origin. Scramjet keeps its
//     own jar, so the two have to be reconciled by the host (see extension.ts).

import type { ProxyTransport, RawHeaders, TransferrableResponse, WebSocketDataType } from "@mercuryworkshop/proxy-transports";
import { STACK_OWNED_REQUEST_HEADERS, isRedirect, rawResponseHeaders, type Notice } from "./types";

export type DirectTransportOptions = {
	/** Where to get the network from. Defaults to the globals; injectable for tests and workers. */
	fetch?: typeof globalThis.fetch;
	WebSocket?: typeof globalThis.WebSocket;
	/** `credentials` for every request. Default `omit`, so the browser's jar never leaks into Scramjet's. */
	credentials?: RequestCredentials;
	/** Redirects to follow before handing the response back. `libcurl` translates redirects too. Default 10. */
	maxRedirects?: number;
	/** Wall clock budget for one `request()`. Default 45s, matching the shell's navigation timeout. */
	timeoutMs?: number;
	/**
	 * Pass stack-owned headers through instead of dropping them. Only useful when the host
	 * can enforce them (a browser extension rewriting headers with declarativeNetRequest);
	 * a plain page will just have them ignored.
	 */
	setStackOwnedHeaders?: boolean;
	/**
	 * Awaited before every hop. A host uses it to make the browser's jar agree with its own
	 * (see extension.ts): the browser will send *its* cookies, not the ones in `headers`.
	 */
	onBeforeRequest?: (url: URL) => Promise<void> | void;
	/**
	 * Called with the response headers of every hop, `set-cookie` included. The browser keeps
	 * the jar the wire used; this is how a host learns what the site set.
	 */
	onResponseHeaders?: (url: URL, headers: RawHeaders) => void;
	/** Diagnostics. `host` is the only request URL ever passed here. */
	onNotice?: Notice;
};

export class DirectTransport implements ProxyTransport {
	ready = false;

	#fetch: typeof globalThis.fetch;
	#WebSocket: typeof globalThis.WebSocket;
	#hooks: Pick<DirectTransportOptions, "onBeforeRequest" | "onResponseHeaders">;
	#options: Required<Omit<DirectTransportOptions, "fetch" | "WebSocket" | "onNotice" | "onBeforeRequest" | "onResponseHeaders">> & {
		onNotice: Notice | undefined;
	};

	constructor(options: DirectTransportOptions = {}) {
		// the browser's fetch must be called with `this` = the global ("Illegal invocation" otherwise)
		this.#fetch = options.fetch ?? (globalThis.fetch?.bind(globalThis) as typeof globalThis.fetch);
		this.#WebSocket = options.WebSocket ?? globalThis.WebSocket;
		this.#hooks = options;
		this.#options = {
			credentials: options.credentials ?? "omit",
			maxRedirects: options.maxRedirects ?? 10,
			timeoutMs: options.timeoutMs ?? 45_000,
			setStackOwnedHeaders: options.setStackOwnedHeaders ?? false,
			onNotice: options.onNotice,
		};
	}

	async init(): Promise<void> {
		if (typeof this.#fetch !== "function") throw new Error("fetch is not available in this context");
		if (typeof this.#WebSocket !== "function") throw new Error("WebSocket is not available in this context");
		this.ready = true;
	}

	#headers(headers: RawHeaders): Headers {
		const out = new Headers();
		for (const [name, value] of headers) {
			if (!this.#options.setStackOwnedHeaders && STACK_OWNED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
			// `Host` is never settable; `Content-Length` breaks if the body was mutated; both are covered above.
			out.append(name, value);
		}
		return out;
	}

	async request(remote: URL, method: string, body: BodyInit | null, headers: RawHeaders, signal: AbortSignal | undefined): Promise<TransferrableResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`direct request timed out after ${this.#options.timeoutMs}ms`)), this.#options.timeoutMs);
		const forward = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", forward, { once: true });
		// The caller may already have aborted before this ran (an `await` earlier in the
		// function yields, and a signal aborted before `addEventListener` fires no event).
		if (signal?.aborted) forward();

		try {
			let url = remote;
			let currentMethod = method;
			let currentBody = body;
			const setCookies: string[] = [];

			for (let hop = 0; ; hop++) {
				await this.#hooks.onBeforeRequest?.(url);
				const response = await this.#fetch(url, {
					method: currentMethod,
					// GET/HEAD must not carry a body: replaying a body after a 303 upsets some servers.
					body: currentMethod === "GET" || currentMethod === "HEAD" ? null : currentBody,
					headers: this.#headers(headers),
					redirect: "manual",
					credentials: this.#options.credentials,
					signal: controller.signal,
				});

				// The host sees every hop: a redirect's `Set-Cookie` is as real as the final one's.
				const hopHeaders = rawResponseHeaders(response.headers);
				this.#hooks.onResponseHeaders?.(url, hopHeaders);
				for (const [name, value] of hopHeaders) if (name === "set-cookie") setCookies.push(value);

				const location = response.headers.get("location");
				if (!isRedirect(response.status) || !location) {
					const out = rawResponseHeaders(response.headers);
					// A redirect chain's cookies belong to the chain, not to the final response.
					for (const value of setCookies) if (!out.some(([n, v]) => n === "set-cookie" && v === value)) out.push(["set-cookie", value]);
					return {
						body: (response.body ?? new Uint8Array()) as TransferrableResponse["body"],
						headers: out,
						status: response.status,
						statusText: response.statusText,
					};
				}

				if (hop >= this.#options.maxRedirects) {
					this.#options.onNotice?.("warn", `too many redirects (${url.host})`);
					return {
						body: (response.body ?? new Uint8Array()) as TransferrableResponse["body"],
						headers: rawResponseHeaders(response.headers),
						status: response.status,
						statusText: response.statusText,
					};
				}

				const next = new URL(location, url);
				const dropBody = response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod.toUpperCase() === "POST");
				// The body is a stream: it can only be replayed if it was not consumed and is not a stream.
				if (dropBody) {
					currentBody = null;
					currentMethod = "GET";
				}
				url = next;
				void response.body?.cancel().catch(() => {});
			}
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", forward);
		}
	}

	connect(
		remote: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void,
	): [(data: WebSocketDataType) => void, (code: number, reason: string) => void] {
		// `requestHeaders` cannot be set on a WebSocket handshake: the browser owns it.
		void [requestHeaders, this.#options];
		const socket = new this.#WebSocket(remote.href, protocols.length ? protocols : undefined);
		socket.binaryType = "arraybuffer";
		socket.onopen = () => onopen(socket.protocol, socket.extensions ?? "");
		socket.onmessage = (event) => onmessage(event.data as WebSocketDataType);
		socket.onclose = (event) => onclose(event.code, event.reason);
		socket.onerror = () => onerror(`websocket error (${remote.host})`);
		return [
			(data) => socket.send(data as Parameters<WebSocket["send"]>[0]),
			(code, reason) => {
				try {
					socket.close(code, reason);
				} catch {
					socket.close();
				}
			},
		];
	}
}
