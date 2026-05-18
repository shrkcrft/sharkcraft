# Release flow

SharkCraft's release process is mechanical and dry-runnable.

## Quick check

```bash
bun run release:dry-run
```

Runs typecheck → tests → build-dist → publish-dry-run → release readiness.
No tarballs are written, no publish happens.

## Step-by-step

1. **Bump versions across packages**:

   ```bash
   bun run bump-versions 0.1.0-alpha.2 --dry-run     # preview
   bun run bump-versions 0.1.0-alpha.2 --write       # apply
   ```

   The script updates `packages/*/package.json` versions and rewrites any
   internal `@shrkcrft/*` pin that isn't `workspace:*` to `^<version>`.
   `workspace:*` pins are dev-mode and stay untouched; switch them at publish
   time if needed.

2. **Build dist**:

   ```bash
   bun run build:dist
   ```

3. **Publish dry-run**:

   ```bash
   bun run publish:dry-run
   ```

   Reports per-package tarball sizes and contents.

4. **Release readiness check**:

   ```bash
   bun run release:check
   ```

   Flags missing description / license / repository / exports / files
   entries; flags `workspace:*` internal pins; flags `bin` entries pointing
   at source.

5. **Publish per package** (when ready):

   ```bash
   for pkg in core config workspace knowledge rules paths templates \
              context pipelines packs generator inspector ai plugin-api \
              shared mcp-server cli; do
     (cd packages/$pkg && npm publish --access public --tag next)
   done
   ```

## What ships and what doesn't

- `packages/*` → published (when `private: false` and `publishConfig.access: public`).
- `packages/dashboard` → publishable, but its `dist/` is a Vite-built browser
  bundle (`index.html` + chunked JS/CSS). `publish-dry-run` accepts
  `dist/index.html` or `dist/index.js` as the entry point.
- `examples/*` → never published; `private: true` on all of them.
- `e2e/` → never published (not under `packages/`).
- `bun.lock` → not in the tarball.
- `src/` is shipped under `files: ["src"]` during alpha. For the first non-alpha tag we'll switch `main`/`types`/`exports`/`bin` to `dist/...` and ship `dist/` instead.

## Cutting a non-alpha release

1. `bun run bump-versions <version> --write`
2. Run `scripts/publish-dry-run.ts` once; that script temporarily swaps
   `package.json` to publish-mode (`dist/...`) so the tarball reflects what
   npm will actually receive.
3. `bun run release:check`
4. Publish.

## Tags

- `next` for alpha / beta / RC.
- `latest` only after a release we're willing to recommend by default.

## Failure modes the dry-run catches

| Failure | Where it's caught |
|---|---|
| Type errors | typecheck step |
| Test regressions | bun test step |
| dist won't build | build-dist step |
| Missing `files` / wrong `exports` | publish-dry-run step |
| `bin` points to `./src/main.ts` | release:check |
| Workspace pin leaked into a tarball | release:check |
| Manifest validation breaks a pack | discovery in test fixtures |
