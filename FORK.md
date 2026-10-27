# Fork notice: shasta-scramjet

This is a **fork of [MercuryWorkshop/scramjet](https://github.com/MercuryWorkshop/scramjet)**,
maintained for the [Shasta](https://github.com/dazacode/Shastaweb) browser OS.

It exists so that Shasta's engine work — a handful of upstream fixes plus a transport-porting
project — can be versioned, built, tested and rolled back on its own, instead of living as
patches in the Shasta repository.

## Attribution

Scramjet is Copyright (C) Mercury Workshop and its contributors, licensed AGPL-3.0-only.
Everything below the `shasta` branch's first three commits is theirs, unmodified, with its
original history and authorship intact. `LICENSE` in this repository is the AGPL-3.0 text
upstream declares in its `package.json`.

When we change a file, we change only what the change needs. New code goes in new files
(`packages/transports/`) wherever possible, so `git diff upstream/main` stays readable and a
future rebase onto upstream is a small job.

## Branches

| Branch | What it is | Rule |
|---|---|---|
| `main` | Upstream, fast-forward only | never commit here; only `git merge --ff-only upstream/main` |
| `shasta` | Our integration branch, the default branch, what Shasta pins | where all work happens |

Tags: `shasta-vX.Y.Z` mark what Shasta has pinned. A tag is immutable once Shasta's submodule
has been pointed at it.

## What is different from upstream

Three fixes carried over from Shasta (each its own commit, each with the original reasoning in
the commit message):

| Commit | File(s) | Why |
|---|---|---|
| `fix(xhr): let synchronous XHR from a worker pass through` | `core/src/client/shared/requests/xmlhttprequest.ts` | upstream called a non-existent flag and threw; Emscripten `httpfs` filesystems need it |
| `fix(rewriter): blob: URLs and module workers` | `core/src/client/dom/element.ts`, `client/shared/error.ts`, `fetch/fetch.ts`, `shared/rewriters/url.ts`, `shared/rewriters/worker.ts` | blob/module workers and dynamically written scripts |
| `fix(demo): default to a same-origin /wisp/ endpoint` | `demo/src/store.ts` | the demo had no endpoint at all without `VITE_WISP_URL` |

And one additive package:

- `packages/transports/` — `DirectTransport` (the browser's own network, no relay) and
  `HybridTransport` (direct when it works, relay when it does not), plus the extension-only
  cookie bridge. Depends on nothing but `@mercuryworkshop/proxy-transports`.

These are **not** submitted upstream as a matter of policy — if any of them is fixed upstream,
the commit is dropped on the next sync.

## Sync from upstream

```sh
git fetch upstream
git switch main && git merge --ff-only upstream/main
git switch shasta && git rebase main
bun test --cwd packages/transports        # or: pnpm -F @shasta/transports test
git push --force-with-lease origin shasta # the branch is rebased, not merged
```

Then bump Shasta's pin (see "Releasing a pin" below). If a rebase conflicts, it will be in one
of the seven files above; the conflict is either "upstream fixed it" (drop the commit) or
"upstream moved around it" (rebase the hunk).

Rebasing rather than merging keeps `git diff upstream/main` equal to the list above, which is
what makes this cheap to maintain.

## Build the engine

Needs Node ≥ 24, pnpm, `rustup`, `wasm-bindgen` 0.2.105, `wasm-opt` (Binaryen) and
[this `wasm-snip` fork](https://github.com/r58Playz/wasm-snip) — the same list as upstream's
README. Shasta's `scripts/run.ts` performs this for you.

```sh
pnpm install --frozen-lockfile
pnpm --filter @mercuryworkshop/scramjet rewriter:build   # wasm rewriter, needs Rust
pnpm --filter @mercuryworkshop/scramjet build            # core + controller bundles
```

Artifacts land in `packages/core/dist/` and `packages/controller/dist/`. They are **not**
committed: the build is the contract, and Shasta rebuilds from the pinned commit.

## Releasing a pin

1. `bun test` and `pnpm -r typecheck` are green on `shasta`.
2. `git tag -s shasta-vX.Y.Z -m "…"` and push the tag.
3. In Shasta: `git -C scramjet fetch --tags && git -C scramjet checkout shasta-vX.Y.Z`.
4. Commit the gitlink bump in Shasta and run its checks.

## Roll back

Rolling back is a checkout of a tag that is already known to work — nothing else moved:

```sh
# in Shasta
git -C scramjet checkout shasta-vX.Y.0        # the previous tag
bun run build                                  # rebuilds the engine
```

If the fork itself is the problem, Shasta's submodule can be pointed at an upstream commit by
hash: `git -C scramjet checkout b14b709a`. The three fix commits are additive, so an upstream
commit builds without them (it just regresses the three behaviours above).

## Licensing

AGPL-3.0-only, as upstream. This repository being public is what discharges AGPL §13 for the
engine that Shasta serves over the network: the source of the exact pinned commit is fetchable
by any user. `LICENSE` covers the whole repository. Anything shipped that is not AGPL is
listed here:

| Component | License |
|---|---|
| Scramjet, `packages/**` | AGPL-3.0-only |
| `@mercuryworkshop/proxy-transports` (dev dependency of `packages/transports`) | MIT |
