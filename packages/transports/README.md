# @shasta/transports

`@mercuryworkshop/proxy-transports` implementations that use the browser's own network
instead of a relay, and one that only uses a relay when it has to.

Not Scramjet-specific: these are plain `ProxyTransport` objects. They work with any Scramjet
build, any other consumer of the interface, and with no Wisp server at all for the direct one.

```ts
import { DirectTransport, HybridTransport } from "@shasta/transports";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";

// direct only
const controller = new Controller({ serviceworker, transport: new DirectTransport() });

// direct when it works, relay when it does not
const controller = new Controller({
	serviceworker,
	transport: new HybridTransport({
		primary: new DirectTransport(),
		fallback: new LibcurlClient({ wisp: "wss://relay.example/wisp/" }),
	}),
});
```

Consumed from source (`exports` points at `src/index.ts`): there is nothing to build, and the
host's bundler compiles it. `pnpm typecheck` and `bun test` cover it here.

## `DirectTransport`

`request()` is `fetch()`, `connect()` is `new WebSocket()`. No server.

It follows redirects itself (so the caller sees the chain's `Set-Cookie` and the final
response, like libcurl does), forwards an outside `AbortSignal`, enforces a timeout, and
exposes `onBeforeRequest` / `onResponseHeaders` hooks for a host that needs to keep its own
cookie jar in step.

### What it cannot do, and why

| Limit | Cause |
|---|---|
| A plain page only loads sites that send `Access-Control-Allow-Origin` | `fetch()` from a page is CORS-checked. `mode: "no-cors"` is no help: status `0`, no headers, no readable body. |
| `Cookie`, `Host`, `Origin`, `Referer`, `Accept-Encoding`, `Connection`, `Content-Length` cannot be sent | the Fetch spec's forbidden header names. `setStackOwnedHeaders: true` passes them anyway for a host that can enforce them (a browser extension using DNR). |
| No raw TCP — http(s) and ws(s) only | the browser has no socket API. Wisp can reach arbitrary TCP; this cannot. |
| No custom WebSocket handshake headers | `new WebSocket()` takes no headers. |
| The browser's cookie jar, not Scramjet's, is what goes on the wire | see `extension.ts` |

In a `chrome-extension://` page with `host_permissions: ["<all_urls>"]` the first two stop
mattering: extension-context fetches are not CORS-checked and DNR can rewrite the stack-owned
headers.

## `HybridTransport`

`primary` is tried first; a `request()` that fails before returning a response (network error,
CORS) is retried on `fallback`. A host that has failed `failuresBeforeSkip` times in a row is
skipped for the primary from then on — one success clears it. `connect()` is synchronous by
contract, so it picks a side from what earlier requests learned, and a synchronous throw or an
`onerror` marks the host for the fallback.

A response body is a stream, so a failure *after* a response is returned is not replayed.

## `extension.ts`

Extension-only. `createCookieBridge(store)` pushes the host's cookies for a URL into the
browser's jar before a request, and reads `Set-Cookie` back off the response through
`webRequest` (with `extraHeaders`; the bridge does not use `webRequestBlocking`, which is
policy-install-only in MV3). Needs `permissions: ["cookies", "webRequest"]`.

`extensionCapabilities()` reports what the running browser will actually allow.

## Status

Experimental, and honest about it: `stackHeaders` is `false` (the declarativeNetRequest rules
for `Origin` / `Referer` / `Cookie` are not wired up yet). See `FORK.md` in the repository root
for how this is being evaluated.
