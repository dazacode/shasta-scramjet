// Try the browser's own network first; fall back to a relay when it cannot do the job.
//
// This is the shape the whole exercise is for: a direct transport is free and local, but
// it cannot serve a page that the browser will not let you read. Rather than picking one,
// a hybrid keeps both and only pays for the relay when the direct path actually fails.
//
// Failure handling is deliberately coarse. A `request()` that fails *before* returning a
// response (network error, CORS) is retried on the fallback — the common case. Once a
// response has been handed back its body is a stream and is not replayed, so a failure
// after that point is the caller's problem. `connect()` is synchronous by contract, so it
// picks a side using what earlier requests learned about the host.

import type { ProxyTransport, RawHeaders, TransferrableResponse, WebSocketDataType } from "@mercuryworkshop/proxy-transports";
import type { Notice } from "./types";

export type HybridTransportOptions = {
	/** Local, no server. Should be a `DirectTransport`. */
	primary: ProxyTransport;
	/** A relay. Should be a Wisp-backed transport (libcurl or epoxy). */
	fallback: ProxyTransport;
	/** Skip the primary for URLs it can never serve. */
	canHandle?: (url: URL) => boolean;
	/** How many consecutive failures before a host is skipped without trying. Default 1 (trust learning). */
	failuresBeforeSkip?: number;
	onNotice?: Notice;
};

export class HybridTransport implements ProxyTransport {
	ready = false;

	#primary: ProxyTransport;
	#fallback: ProxyTransport;
	#canHandle: (url: URL) => boolean;
	#skipAfter: number;
	#onNotice: Notice | undefined;
	/** host -> consecutive direct failures. Cleared by one success. */
	#failures = new Map<string, number>();

	constructor(options: HybridTransportOptions) {
		this.#primary = options.primary;
		this.#fallback = options.fallback;
		this.#canHandle = options.canHandle ?? (() => true);
		this.#skipAfter = options.failuresBeforeSkip ?? 1;
		this.#onNotice = options.onNotice;
	}

	async init(): Promise<void> {
		// A dead relay must not stop the shell from booting, and a direct path that is
		// unavailable (no `fetch`) must not either: either one alone is useful.
		const [primary, fallback] = await Promise.allSettled([this.#primary.init(), this.#fallback.init()]);
		if (primary.status === "rejected") this.#onNotice?.("warn", `direct transport unavailable: ${String(primary.reason)}`);
		if (fallback.status === "rejected") this.#onNotice?.("warn", `relay transport unavailable: ${String(fallback.reason)}`);
		if (primary.status === "rejected" && fallback.status === "rejected") throw primary.reason;
		this.ready = true;
	}

	#preferDirect(url: URL): boolean {
		return this.#primary.ready && this.#canHandle(url) && (this.#failures.get(url.host) ?? 0) < this.#skipAfter;
	}

	async request(remote: URL, method: string, body: BodyInit | null, headers: RawHeaders, signal: AbortSignal | undefined): Promise<TransferrableResponse> {
		if (this.#preferDirect(remote)) {
			try {
				const response = await this.#primary.request(remote, method, body, headers, signal);
				this.#failures.delete(remote.host);
				return response;
			} catch (error) {
				if (signal?.aborted) throw error;
				const count = (this.#failures.get(remote.host) ?? 0) + 1;
				this.#failures.set(remote.host, count);
				if (count === 1) this.#onNotice?.("info", `direct failed, using the relay (${remote.host}): ${String(error)}`);
			}
		}
		return this.#fallback.request(remote, method, body, headers, signal);
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
		const preferDirect = this.#preferDirect(remote);
		const transport = preferDirect ? this.#primary : this.#fallback;
		try {
			return transport.connect(remote, protocols, requestHeaders, onopen, onmessage, onclose, (error) => {
				if (preferDirect) {
					this.#failures.set(remote.host, (this.#failures.get(remote.host) ?? 0) + 1);
					this.#onNotice?.("info", `direct websocket failed, the relay takes the next one (${remote.host}): ${error}`);
				}
				onerror(error);
			});
		} catch (error) {
			if (!preferDirect) throw error;
			this.#failures.set(remote.host, (this.#failures.get(remote.host) ?? 0) + 1);
			return this.#fallback.connect(remote, protocols, requestHeaders, onopen, onmessage, onclose, onerror);
		}
	}

	/** Hosts currently being served by the relay because the direct path failed. */
	get relayHosts(): string[] {
		return [...this.#failures.keys()];
	}

	/** Forget what was learned (after a reconnect, or when the user changes settings). */
	reset(): void {
		this.#failures.clear();
	}
}
