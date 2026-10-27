import { rewriteJs } from "@rewriters/js";
import { ScramjetClient, ProxyCtx, Proxy } from "@client/index";

function rewriteFunction<T extends string, U extends "construct" | "apply">(
	ctx: ProxyCtx<T, U>,
	client: ScramjetClient
) {
	const stringifiedFunction = ctx.call().toString();

	// TODO: also check if the function comes from a weird realm. if so we need to completely block it or do something else weird
	// not much point rewriting the javascript if it's executing in the top level

	const content = rewriteJs(
		`return ${stringifiedFunction}`,
		"(function proxy)",
		client.context,
		client.meta
	);
	ctx.return(ctx.fn(content)());
}

export default function (client: ScramjetClient, _self: Self) {
	const handler: Proxy = {
		apply(ctx: ProxyCtx) {
			rewriteFunction(ctx, client);
		},
		construct(ctx) {
			rewriteFunction(ctx, client);
		},
	};

	client.Proxy("Function", handler);

	// The constructors of the hooked realm. eval gets them from that realm even when this code runs in a
	// parent's; under a CSP without 'unsafe-eval' (an Isolated Web App) it throws, and this realm's own are
	// used, which is the same realm whenever a page hooks itself (the usual case).
	const rawCtor = (source: string, local: Function) => {
		try {
			return client.natives.call("eval", null, source).constructor;
		} catch {
			return local.constructor;
		}
	};
	const RawFunction = rawCtor("(function () {})", function () {});
	const RawAsyncFunction = rawCtor("(async function () {})", async function () {});
	const RawGeneratorFunction = rawCtor("(function* () {})", function* () {});
	const RawAsyncGeneratorFunction = rawCtor(
		"(async function* () {})",
		async function* () {}
	);

	client.RawProxy(RawFunction.prototype, "constructor", handler);
	client.RawProxy(RawAsyncFunction.prototype, "constructor", handler);
	client.RawProxy(RawGeneratorFunction.prototype, "constructor", handler);
	client.RawProxy(RawAsyncGeneratorFunction.prototype, "constructor", handler);
}
