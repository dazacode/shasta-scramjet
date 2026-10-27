import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient, _self: Self) {
	client.Proxy("Navigator.prototype.sendBeacon", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(url);
			// sendBeacon only takes http(s); a proxy served from another scheme (an Isolated Web App's
			// isolated-app:) sends the same POST as a keepalive fetch through the page's (hooked) fetch
			if (!/^https?:/i.test(ctx.args[0])) {
				Promise.resolve()
					.then(() =>
						client.global.fetch(url, {
							method: "POST",
							body: ctx.args[1] ?? null,
							keepalive: true,
							credentials: "include",
						})
					)
					.catch(() => {});
				ctx.return(true);
			}
		},
	});
}
