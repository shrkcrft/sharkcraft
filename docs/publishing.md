# Publishing

SharkCraft is **not** published yet. This document captures the plan so the
first release is mechanical.

## Strategy

- **First release tag**: `0.1.0-alpha.2`. Use the `next` dist-tag, not `latest`,
  so consumers must opt in via `bun add @shrkcrft/cli@next`.
- Each package version is kept in lockstep during alpha. Bump every package
  together until APIs are stable.
- Root `package.json` stays `"private": true`. Only `packages/*` get published.

## What gets published in v0.1.0-alpha.2

Order matters — leaf packages first, so consumers of CLI/MCP-server resolve
fresh tarballs:

1. `@shrkcrft/core`
2. `@shrkcrft/config`
3. `@shrkcrft/workspace`
4. `@shrkcrft/knowledge`
5. `@shrkcrft/rules`
6. `@shrkcrft/paths`
7. `@shrkcrft/templates`
8. `@shrkcrft/context`
9. `@shrkcrft/generator`
10. `@shrkcrft/inspector`
11. `@shrkcrft/ai`
12. `@shrkcrft/plugin-api`
13. `@shrkcrft/shared`
14. `@shrkcrft/mcp-server`
15. `@shrkcrft/cli`

Examples (`examples/*`) stay private.

## Bun-specific notes

- During development each package's `main` / `types` point at `./src/index.ts`
  so Bun resolves source directly with no build step.
- For publishing we compile each package to `dist/` with TypeScript:
  - `scripts/build-dist.ts` topo-sorts packages by `@shrkcrft/*` deps,
    generates a per-package `tsconfig.build.json` that points cross-package
    `paths` at the already-built `dist/index.d.ts`, runs `tsc`, then
    post-processes emitted `.d.ts` files to rewrite `.ts` import specifiers
    to `.js` (NodeNext-friendly).
  - `scripts/publish-dry-run.ts` switches each `package.json` `main` / `types`
    / `exports` / `bin` to the dist paths, runs `npm pack --dry-run --json`,
    restores the dev `package.json`, and prints a tarball-size report.
- `bun.lock` does not ship — npm consumers use their own lockfile.
- `engines: { node: ">=18" }` is set so npm clients accept the package; we
  still recommend Bun >= 1.1 for first-class support.

## Pre-publish checklist

1. `bun install`
2. `bun test` (must be green)
3. `bun x tsc -p tsconfig.base.json --noEmit`
4. `bun run shrk doctor` against `examples/dogfood-target` (must verdict
   "Ready for AI-agent use")
5. Manually probe MCP `initialize` + `tools/list` + a representative
   `tools/call`.
6. Bump versions across all packages to the alpha tag:
   ```bash
   # All packages share a version during alpha. Edit each package.json or
   # use a small one-off script. A formal bump-versions helper will land in v0.2.
   ```
7. Compile to dist:
   ```bash
   bun run scripts/build-dist.ts       # emits packages/*/dist/{*.js, *.d.ts}
   ```
8. Dry-run publish (no tarballs are written; no publishing happens):
   ```bash
   bun run scripts/publish-dry-run.ts  # prints tarball sizes per package
   ```
9. When the dry-run looks right, publish per package, in the order listed
   above:
   ```bash
   for pkg in core config workspace knowledge rules paths templates \
              context generator inspector ai plugin-api shared \
              mcp-server cli; do
     (cd packages/$pkg && npm publish --access public --tag next)
   done
   ```
   (Run the package.json swap from `publish-dry-run.ts` first; it does the
   `main/types/exports/bin` rewrite. Restore source paths afterwards for
   continued local development.)

## Security gates before tagging `latest`

- Generator must refuse paths outside the project root (already enforced by
  `safeResolveTargetPath`).
- MCP tool inputs must validate (already enforced via zod).
- `shrk gen` must dry-run by default (already enforced).
- README must clearly say "alpha" until the first non-alpha tag.

## After publishing

- Update `README.md` install snippets from `bun run shrk` to `bun x @shrkcrft/cli`.
- Update `docs/claude-code.md` `args` to use the published `bunx`/`npx` form.
- Open a `latest-tag` issue tracking what we want before promoting from `next`
  to `latest`.
