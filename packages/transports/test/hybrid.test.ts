import { describe, expect, it } from "bun:test";
import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";
import { HybridTransport } from "../src/hybrid";

function stub(name: string, behaviour: { failRequests?: boolean; failConnects?: boolean; failInit?: boolean }) {
	const calls: string[] = [];
	const transport: ProxyTransport = {
		ready: false,
		init: async () => {
			calls.push(`${name}:init`);
			if (behaviour.failInit) throw new Error(`${name} init failed`);
			transport.ready = true;
		},
		request: async () => {
			calls.push(`${name}:request`);
			if (behaviour.failRequests) throw new Error(`${name} request failed`);
			return { body: new ArrayBuffer(0), headers: [["x-from", name]], status: 200, statusText: "OK" };
		},
		connect: () => {
			calls.push(`${name}:connect`);
			if (behaviour.failConnects) throw new Error(`${name} connect failed`);
			return [() => {}, () => {}];
		},
	};
	return { transport, calls };
}

const url = new URL("https://example.com/page");

describe("HybridTransport", () => {
	it("prefers the direct transport", async () => {
		const primary = stub("direct", {});
		const fallback = stub("relay", {});
		const hybrid = new HybridTransport({ primary: primary.transport, fallback: fallback.transport });
		await hybrid.init();

		const result = await hybrid.request(url, "GET", null, [], undefined);
		expect(result.headers).toEqual([["x-from", "direct"]]);
		expect(fallback.calls).toEqual(["relay:init"]);
	});

	it("falls back once and then stops trying the direct path for that host", async () => {
		const primary = stub("direct", { failRequests: true });
		const fallback = stub("relay", {});
		const notices: string[] = [];
		const hybrid = new HybridTransport({ primary: primary.transport, fallback: fallback.transport, onNotice: (_level, message) => void notices.push(message) });
		await hybrid.init();

		expect((await hybrid.request(url, "GET", null, [], undefined)).headers).toEqual([["x-from", "relay"]]);
		expect(hybrid.relayHosts).toEqual(["example.com"]);
		expect(notices).toHaveLength(1);

		await hybrid.request(url, "GET", null, [], undefined);
		// one direct attempt, two relay requests
		expect(primary.calls.filter((c) => c === "direct:request")).toHaveLength(1);
		expect(fallback.calls.filter((c) => c === "relay:request")).toHaveLength(2);
	});

	it("a different host still gets the direct path", async () => {
		const primary = stub("direct", { failRequests: true });
		const fallback = stub("relay", {});
		const hybrid = new HybridTransport({ primary: primary.transport, fallback: fallback.transport });
		await hybrid.init();

		await hybrid.request(url, "GET", null, [], undefined);
		await hybrid.request(new URL("https://other.test/"), "GET", null, [], undefined);
		expect(primary.calls.filter((c) => c === "direct:request")).toHaveLength(2);
	});

	it("can be told a host is never direct", async () => {
		const primary = stub("direct", {});
		const fallback = stub("relay", {});
		const hybrid = new HybridTransport({ primary: primary.transport, fallback: fallback.transport, canHandle: (u) => u.host !== "example.com" });
		await hybrid.init();

		await hybrid.request(url, "GET", null, [], undefined);
		expect(primary.calls).toEqual(["direct:init"]);
	});

	it("does not retry a request that was aborted from outside", async () => {
		const controller = new AbortController();
		const primary: ProxyTransport = {
			ready: true,
			init: async () => {},
			request: async () => {
				controller.abort();
				throw new Error("aborted");
			},
			connect: () => [() => {}, () => {}],
		};
		const fallback = stub("relay", {});
		const hybrid = new HybridTransport({ primary, fallback: fallback.transport });
		await hybrid.init();

		await expect(hybrid.request(url, "GET", null, [], controller.signal)).rejects.toThrow("aborted");
		expect(fallback.calls.filter((c) => c === "relay:request")).toHaveLength(0);
	});

	it("sends a socket to the fallback after the direct websocket failed", async () => {
		const primary = stub("direct", { failConnects: true });
		const fallback = stub("relay", {});
		const hybrid = new HybridTransport({ primary: primary.transport, fallback: fallback.transport });
		await hybrid.init();

		hybrid.connect(url, [], [], () => {}, () => {}, () => {}, () => {});
		expect(primary.calls).toContain("direct:connect");
		expect(fallback.calls).toContain("relay:connect");
	});

	it("boots with only one side up", async () => {
		const primary = stub("direct", { failInit: true });
		const fallback = stub("relay", {});
		const notices: string[] = [];
		const hybrid = new HybridTransport({ primary: primary.transport, fallback: fallback.transport, onNotice: (_l, m) => void notices.push(m) });
		await hybrid.init();

		expect(hybrid.ready).toBe(true);
		expect(notices).toHaveLength(1);
		expect((await hybrid.request(url, "GET", null, [], undefined)).headers).toEqual([["x-from", "relay"]]);
	});

	it("fails init when neither side is up", async () => {
		const primary = stub("direct", { failInit: true });
		const fallback = stub("relay", { failInit: true });
		const hybrid = new HybridTransport({ primary: primary.transport, fallback: fallback.transport });
		await expect(hybrid.init()).rejects.toBeDefined();
	});
});
