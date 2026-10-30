import { ScramjetClient } from "@client/index";
import { Object_keys, Reflect_get, Reflect_ownKeys } from "@/shared/snapshot";

export default function (client: ScramjetClient, self: Self) {
	// with a storage scope, localStorage lives in the tab's sessionStorage too, under its own key prefix
	const scoped = !!client.config.storageScope;
	const proxyFor = (target: Storage, pfx: string) =>
		new Proxy(target, makeHandler(client, pfx));

	const localStorageProxy = scoped
		? proxyFor(self.sessionStorage, "\u0001L")
		: proxyFor(self.localStorage, "");
	const sessionStorageProxy = proxyFor(self.sessionStorage, "");

	delete self.localStorage;
	delete self.sessionStorage;

	self.localStorage = localStorageProxy;
	self.sessionStorage = sessionStorageProxy;
}

function makeHandler(
	client: ScramjetClient,
	pfx: string
): ProxyHandler<Storage> {
	// `host` is read per call: a frame's client.url changes as it navigates
	const host = () => pfx + client.url.host;
	return {
		get(target, prop) {
			switch (prop) {
				case "getItem":
					return (key: string) => {
						return target.getItem(host() + "@" + key);
					};

				case "setItem":
					return (key: string, value: string) => {
						return target.setItem(host() + "@" + key, value);
					};

				case "removeItem":
					return (key: string) => {
						return target.removeItem(host() + "@" + key);
					};

				case "clear":
					return () => {
						for (const key of Object_keys(target)) {
							if (key.startsWith(host() + "@")) {
								target.removeItem(key);
							}
						}
					};

				case "key":
					return (index: number) => {
						const keys = Object_keys(target).filter((key) =>
							key.startsWith(host() + "@")
						);

						return target.getItem(keys[index]);
					};

				case "length":
					return Object_keys(target).filter((key) =>
						key.startsWith(host() + "@")
					).length;

				default:
					if (prop in Object.prototype || typeof prop === "symbol") {
						return Reflect_get(target, prop);
					}

					return target.getItem(host() + "@" + (prop as string));
			}
		},

		set(target, prop, value) {
			target.setItem(host() + "@" + (prop as string), value);

			return true;
		},

		has(target, prop) {
			return target.getItem(host() + "@" + (prop as string)) !== null;
		},

		ownKeys(target) {
			return Reflect_ownKeys(target)
				.filter((f) => typeof f === "string" && f.startsWith(host() + "@"))
				.map((f) =>
					typeof f === "string" ? f.substring(host().length + 1) : f
				);
		},

		getOwnPropertyDescriptor(target, property) {
			// TODO: probably not right
			if (
				target.getItem(host() + "@" + (property as string)) === null
			) {
				return undefined;
			}

			return {
				value: target.getItem(host() + "@" + (property as string)),
				enumerable: true,
				configurable: true,
				writable: true,
			};
		},

		defineProperty(target, property, attributes) {
			target.setItem(
				host() + "@" + (property as string),
				attributes.value
			);

			return true;
		},
	};
}
