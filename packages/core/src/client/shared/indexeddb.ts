import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	// a storage scope (see ScramjetConfig.storageScope) goes in front, so the embedder can find a tab's databases
	const scope = client.config.storageScope
		? `${client.config.storageScope}|`
		: "";
	client.Proxy("IDBFactory.prototype.open", {
		apply(ctx) {
			ctx.args[0] = `${scope}${client.url.origin}@${ctx.args[0]}`;
		},
	});
	client.Proxy("IDBFactory.prototype.deleteDatabase", {
		apply(ctx) {
			ctx.args[0] = `${scope}${client.url.origin}@${ctx.args[0]}`;
		},
	});

	client.Trap("IDBDatabase.prototype.name", {
		get(ctx) {
			const name = String(ctx.get());

			return name.substring(name.indexOf("@") + 1);
		},
	});
}
