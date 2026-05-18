# Release checklist — v0.1-alpha

Step-by-step flow to publish SharkCraft `0.1.0-alpha.N` to npm under the
`@shrkcrft/*` scope.

## 0. Branch + clean state

```bash
git switch -c release/0.1.0-alpha.N
git status                                                # must be clean
```

## 1. Bump versions

```bash
bun run scripts/bump-versions.ts 0.1.0-alpha.N
```

This rewrites every `packages/*/package.json` `version` field plus their
internal `"@shrkcrft/<pkg>": "<version>"` dependency pins. Verify:

```bash
git diff -- packages/*/package.json | head -120
```

## 2. Health gates (all must pass)

```bash
bun install                                               # fresh lockfile
bun x tsc -p tsconfig.base.json --noEmit                  # typecheck
bun test                                                  # unit + integration
bun run shrk --cwd examples/dogfood-target doctor \
  --strict --min-score 70                                 # self-check
```

The single command that runs every required gate (typecheck, tests,
build-dist, dashboard-build, publish-dry-run, release-check, install-smoke,
compat-node) is:

```bash
bun run release:preflight
# Optionally append Playwright dashboard E2E (non-blocking):
bun run release:preflight --with-e2e
```

If any gate fails, fix it on the branch before continuing.

## 3. Build dist (publish mode)

```bash
bun run build:dist            # tsc-built TS packages
bun run dashboard:build       # Vite-built browser bundle (@shrkcrft/dashboard)
```

`build:dist` topologically sorts publishable packages by internal dependency
and emits `dist/` from `src/` via a per-package `tsconfig.build.json`. It
skips the `dashboard` package (Vite-built) and any package marked
`private: true`.

`dashboard:build` runs `vite build` inside `packages/dashboard/`, producing
`packages/dashboard/dist/index.html` + chunked JS/CSS. `release:preflight`
runs both automatically.

Sanity-check one package:

```bash
ls packages/cli/dist
cat packages/cli/dist/main.js | head -5
cat packages/cli/dist/main.d.ts | head -5
```

## 4. Publish dry-run

```bash
bun run release:dry-run
```

For each `packages/*` the script:
1. Verifies `package.json` has `name`, `version`, `main`, `types`,
   `exports`, `files`.
2. Verifies `dist/` exists with `index.js` + `index.d.ts`.
3. Runs `npm publish --access=public --dry-run` and captures the file list.

Inspect the file list — no `src/`, no `*.spec.ts`, no `node_modules/`.

## 5. Install smoke test

```bash
bun run scripts/install-smoke-test.ts
```

This builds dist, runs `npm pack` on each package, installs the tarballs
into a temp repo, and runs `shrk --version`, `shrk help`, and
`shrk doctor` to ensure the published shape works end-to-end.

## 6. Tag + push

```bash
git add -A
git commit -m "release: 0.1.0-alpha.N"
git tag v0.1.0-alpha.N
git push origin release/0.1.0-alpha.N
git push origin v0.1.0-alpha.N
```

## 7. Open a PR

```bash
gh pr create --title "Release 0.1.0-alpha.N" \
  --body "See docs/release-checklist.md for the full flow."
```

CI runs the same gates. Merge when green.

## 8. Publish to npm

> Only after the PR is merged and CI is green on `main`.

Publishing is automated through `bun run publish:packages`. The script:

1. Discovers every public package under `packages/*` (skips `private: true`).
2. Topologically sorts by `@shrkcrft/*` deps — leaves first, consumers last.
3. For each package, applies the **same publish-mode `package.json` transform**
   that `publish-dry-run` and `release:smoke-test` already exercise:
   - `main` / `types` / `exports` / `bin` are rewritten from `./src/<x>.ts` to
     `./dist/<x>.{js,d.ts}`.
   - `files` is set to `["dist", "README.md", "LICENSE"]` (no `src` shipped).
   - `workspace:*` internal pins become `^<version>`.
4. Runs `npm publish --access=public --tag <tag>` (or `--dry-run` when asked).
5. **Always** restores the dev `package.json` in a `finally` — even when the
   publish command throws or the user kills the process.

### Dry-run first

```bash
# What this would publish, without touching the registry:
bun run publish:packages --tag alpha --dry-run
```

The dry-run prints the exact npm command per package and the topo order, runs
`build:dist` (unless `--skip-build` is passed), runs `npm publish --dry-run`,
and finishes with a `DRY-RUN` summary. No tarballs are written.

### Real publish

```bash
# After dry-run looks good:
npm whoami                                # confirm logged in
bun run publish:packages --tag alpha      # asks for confirmation
```

The default flow runs `release:preflight` before the first publish (typecheck
+ tests + build + publish-dry-run + release-check + install-smoke-test). Pass
`--yes` to skip the interactive confirm and `--skip-preflight` only if you
just ran the preflight in the same shell.

### Resume after a partial publish

If a publish fails midway (network, OTP timeout, 2FA prompt missed), the
summary tells you which package failed. Re-run from that package onwards:

```bash
bun run publish:packages --tag alpha --from cli      # resume at cli
```

### One package at a time

```bash
bun run publish:packages --tag alpha --only @shrkcrft/cli
bun run publish:packages --tag alpha --only cli      # short name also works
```

### 2FA / OTP

If the npm account requires 2FA on every publish, pass `--otp`:

```bash
bun run publish:packages --tag alpha --otp 123456
```

The OTP is passed verbatim to every `npm publish` call in the run. If it
expires mid-run, use `--from <next-package> --otp <new-code>` to resume.

### Full reference

```
bun run publish:packages [options]

Options:
  --tag <tag>           npm dist-tag (default: alpha)
  --access <access>     npm access level (default: public)
  --dry-run             run `npm publish --dry-run` instead of a real publish
  --from <name>         start publishing from this package (inclusive)
  --only <name>         publish exactly one package
  --otp <code>          npm 2FA code
  --yes, -y             skip the interactive confirmation
  --skip-preflight      skip the release-preflight gate (NOT recommended)
  --skip-build          skip build:dist (assume dist/ is up to date)
```

> `<name>` accepts the short name (`cli`) or full `@shrkcrft/<name>`.

## 9. Post-publish smoke test

In a temp directory outside the repo:

```bash
mkdir -p /tmp/shrk-smoke && cd /tmp/shrk-smoke
npm init -y
npm install @shrkcrft/cli@0.1.0-alpha.N
npx shrk --version
npx shrk init
npx shrk doctor
```

## 10. GitHub release

```bash
gh release create v0.1.0-alpha.N \
  --title "v0.1.0-alpha.N" \
  --notes-file docs/release-notes-0.1.0-alpha.N.md \
  --prerelease
```

## Rollback

If a published version is broken:

```bash
# Within 72h of publish you can deprecate:
npm deprecate @shrkcrft/<pkg>@0.1.0-alpha.N "broken; use 0.1.0-alpha.(N+1)"
```

`npm unpublish` is only allowed within 72h and is strongly discouraged —
prefer deprecating and publishing a fix.

## Pre-flight one-liner

Use the bundled preflight script — it runs each gate, captures durations, and
exits non-zero on the first required failure:

```bash
bun run release:preflight
```

That covers typecheck → tests → build:dist → publish-dry-run →
release:check → install-smoke-test. Equivalent to:

```bash
bun install \
  && bun x tsc -p tsconfig.base.json --noEmit \
  && bun test \
  && bun run shrk --cwd examples/dogfood-target doctor --strict --min-score 70 \
  && bun run build:dist \
  && bun run release:dry-run \
  && bun run scripts/install-smoke-test.ts \
  && echo "Ready to tag + publish."
```

If `release:preflight` exits 0, the release is safe to tag and publish.
