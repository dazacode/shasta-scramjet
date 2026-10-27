import { describe, expect, it } from "bun:test";
import { DirectTransport } from "../src/direct";
import { STACK_OWNED_REQUEST_HEADERS } from "../src/types";

type Call = { url: string; init: RequestInit };

function recorder(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init: init ?? {} });
		return handler(url, init ?? {});
	}) as typeof globalThis.fetch;
	return { calls, fetch };
}

const headersOf = (init: RequestInit): Headers => new Headers(init.headers as HeadersInit);

/**
 * A `fetch` that never settles on its own, like a request that is still in flight. It
 * rejects on abort, including when the signal was already aborted before the call — which
 * is what a real `fetch` does and what the transport has to survive.
 */
function stall() {
	const seen: string[] = [];
	const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const onAbort = () => {
				seen.push("aborted");
				reject(signal?.reason);
			};
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort);
		})) as typeof globalThis.fetch;
	return { seen, fetch };
}

describe("DirectTransport.request", () => {
	it("drops the headers the network stack owns", async () => {
		const { calls, fetch } = recorder(() => new Response("ok"));
		const transport = new DirectTransport({ fetch });
		await transport.init();

		await transport.request(new URL("https://example.com/"), "GET", null, [
			["host", "example.com"],
			["cookie", "a=1"],
			["accept-encoding", "gzip"],
			["x-custom", "yes"],
		], undefined);

		const sent = headersOf(calls[0]!.init);
		expect(sent.get("host")).toBeNull();
		expect(sent.get("cookie")).toBeNull();
		expect(sent.get("accept-encoding")).toBeNull();
		expect(sent.get("x-custom")).toBe("yes");
	});

	it("keeps them when the host can enforce them", async () => {
		const { calls, fetch } = recorder(() => new Response("ok"));
		const transport = new DirectTransport({ fetch, setStackOwnedHeaders: true });
		await transport.init();

		await transport.request(new URL("https://example.com/"), "GET", null, [["referer", "https://other.test/"]], undefined);
		expect(headersOf(calls[0]!.init).get("referer")).toBe("https://other.test/");
	});

	it("never sends a body with GET, even during a replay", async () => {
		const { calls, fetch } = recorder(() => new Response("ok"));
		const transport = new DirectTransport({ fetch });
		await transport.init();

		await transport.request(new URL("https://example.com/"), "GET", "unused", [], undefined);
		expect(calls[0]!.init.body).toBeNull();
	});

	it("follows redirects itself and keeps every hop's cookies", async () => {
		const { calls, fetch } = recorder((url) => {
			if (url.endsWith("/start")) {
				const response = new Response(null, { status: 302, headers: { location: "https://example.com/end" } });
				response.headers.append("set-cookie", "first=1; Path=/");
				return response;
			}
			const response = new Response("done");
			response.headers.append("set-cookie", "second=2; Path=/");
			return response;
		});
		const transport = new DirectTransport({ fetch });
		await transport.init();

		const result = await transport.request(new URL("https://example.com/start"), "GET", null, [], undefined);

		expect(calls).toHaveLength(2);
		expect(calls[1]!.url).toBe("https://example.com/end");
		expect(result.status).toBe(200);
		const cookies = result.headers.filter(([name]) => name === "set-cookie").map(([, value]) => value);
		expect(cookies).toContain("first=1; Path=/");
		expect(cookies).toContain("second=2; Path=/");
	});

	it("turns a 303 into a GET without a body", async () => {
		const { calls, fetch } = recorder((url) =>
			url.endsWith("/start")
				? new Response(null, { status: 303, headers: { location: "/end" } })
				: new Response("ok"),
		);
		const transport = new DirectTransport({ fetch });
		await transport.init();

		await transport.request(new URL("https://example.com/start"), "POST", "payload", [], undefined);
		expect(calls[1]!.init.method).toBe("GET");
		expect(calls[1]!.init.body).toBeNull();
	});

	it("stops after maxRedirects and hands back the last response", async () => {
		const { calls, fetch } = recorder(() => new Response(null, { status: 302, headers: { location: "/loop" } }));
		const transport = new DirectTransport({ fetch, maxRedirects: 3 });
		await transport.init();

		const result = await transport.request(new URL("https://example.com/loop"), "GET", null, [], undefined);
		expect(calls).toHaveLength(4);
		expect(result.status).toBe(302);
	});

	it("reports the host on every hop it touches", async () => {
		const seen: string[] = [];
		const { fetch } = recorder(() => new Response("ok"));
		const transport = new DirectTransport({ fetch, onBeforeRequest: (url) => void seen.push(url.href), onResponseHeaders: () => {} });
		await transport.init();

		await transport.request(new URL("https://example.com/"), "GET", null, [], undefined);
		expect(seen).toEqual(["https://example.com/"]);
	});

	it("aborts on its own timeout", async () => {
		const { fetch } = stall();
		const transport = new DirectTransport({ fetch, timeoutMs: 5 });
		await transport.init();

		await expect(transport.request(new URL("https://example.com/"), "GET", null, [], undefined)).rejects.toBeDefined();
	});

	it("passes an outside abort through", async () => {
		const { seen, fetch } = stall();
		const transport = new DirectTransport({ fetch });
		await transport.init();

		const controller = new AbortController();
		const pending = transport.request(new URL("https://example.com/"), "GET", null, [], controller.signal);
		controller.abort(new Error("stop"));
		await expect(pending).rejects.toThrow("stop");
		expect(seen).toEqual(["aborted"]);
	});

	it("refuses to init without a network", async () => {
		const previous = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
		// @ts-expect-error deliberately removing a global
		globalThis.fetch = undefined;
		// @ts-expect-error deliberately removing a global
		globalThis.WebSocket = undefined;
		try {
			await expect(new DirectTransport().init()).rejects.toThrow();
		} finally {
			globalThis.fetch = previous.fetch;
			globalThis.WebSocket = previous.WebSocket;
		}
	});
});

describe("header bookkeeping", () => {
	it("names the headers a direct transport cannot send", () => {
		for (const name of ["cookie", "host", "origin", "referer", "accept-encoding", "connection", "content-length"]) {
			expect(STACK_OWNED_REQUEST_HEADERS.has(name)).toBe(true);
		}
		expect(STACK_OWNED_REQUEST_HEADERS.has("x-custom")).toBe(false);
	});
});

describe("default fetch", () => {
	it("calls the global fetch with the global as `this` (a browser throws Illegal invocation otherwise)", async () => {
		const real = globalThis.fetch;
		globalThis.fetch = function (this: unknown) {
			if (this !== globalThis && this !== undefined) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
			return Promise.resolve(new Response("ok"));
		} as unknown as typeof globalThis.fetch;
		try {
			const transport = new DirectTransport();
			await transport.init();
			const response = await transport.request(new URL("https://example.test/"), "GET", null, [], undefined);
			expect(response.status).toBe(200);
		} finally {
			globalThis.fetch = real;
		}
	});
});
