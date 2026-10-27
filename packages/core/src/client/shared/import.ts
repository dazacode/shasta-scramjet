import { ScramjetClient } from "@client/index";
import { Object_defineProperty, _URL } from "@/shared/snapshot";

export default function (client: ScramjetClient, self: Self) {
	// import() bound to the hooked realm. Function() throws under a CSP without 'unsafe-eval' (an Isolated Web
	// App); this realm's own import() is then used, which is the same realm whenever a page hooks itself.
	let boundimport: (url: string) => Promise<unknown>;
	try {
		boundimport = client.natives.call(
			"Function",
			null,
			"url",
			"return import(url)"
		);
	} catch {
		boundimport = (url: string) =>
			import(/* webpackIgnore: true */ /* @vite-ignore */ url);
	}

	Object_defineProperty(self, client.config.globals.importfn, {
		value: function (base: string, url: string) {
			const resolved = new _URL(url, base).href;

			if (
				url.includes(":") ||
				url.startsWith("/") ||
				url.startsWith(".") ||
				url.startsWith("..")
			) {
				// this is a url
				return boundimport(client.rewriteUrl(resolved, { isModule: true }));
			} else {
				// this is a specifier handled by importmaps
				return boundimport(url);
			}
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.metafn, {
		value: function (metaobj: any, base: string) {
			metaobj.url = base;
			metaobj.resolve = function (url: string) {
				return new _URL(url, base).href;
			};

			return metaobj;
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
}
