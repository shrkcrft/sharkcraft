# Pack authoring

A SharkCraft pack is a regular npm package whose `package.json` has a
`sharkcraft` section and which contributes `knowledge` / `rules` / `paths` /
`templates` / `pipelines` / `presets` (and optionally `boundaries`) through
its plugin entry.

> R52/R53 cross-links: the local authoring surface for these asset
> kinds — `shrk knowledge add|update|remove`, `shrk rules
> add|update|remove`, `shrk templates scaffold|update|remove` — lives
> in [knowledge-authoring.md](./knowledge-authoring.md). Editing
> pack-shipped assets still requires editing the pack source and
> re-signing the manifest (see
> [pack-signatures.md](./pack-signatures.md) for the dev-vs-release
> distinction). The unified
> [`shrk lint`](./lint.md) entry point aggregates the three per-kind
> doctors when you want a single triage pass across knowledge / rules
> / templates.

## Scaffolding

```bash
shrk packs new my-pack --kind framework --write
shrk packs doctor   my-pack
shrk packs test     my-pack
shrk packs sign     my-pack --secret "$SHARKCRAFT_PACK_SECRET"
shrk packs verify   my-pack
```

`packs new` is **dry-run by default**; pass `--write` to materialize the
files. It refuses to overwrite an existing directory unless you pass
`--force`. The scaffolder never runs `npm install` and never publishes.

## Kinds

The `--kind` flag changes the seed content:

| Kind          | Use for                                                       |
|---------------|---------------------------------------------------------------|
| generic       | Minimal scaffold — knowledge + a placeholder rule             |
| framework     | Includes an example template/pipeline so consumers have a model |
| architecture  | Adds a `boundaries.ts` example for layer rules                |
| enterprise    | Adds review/security baseline docs and a stricter rule seed   |

You can combine `--with-examples` to attach the optional example files to
any kind.

## What gets generated

```
my-pack/
  package.json
  README.md
  SECURITY.md
  tsconfig.json
  src/
    sharkcraft.plugin.ts
    assets/
      knowledge.ts
      rules.ts
      paths.ts
      templates.ts
      pipelines.ts
      presets.ts
      docs/overview.md
```

## Safety

- Packs never auto-run shell commands. Verification commands contributed by
  a pack are surfaced but not executed by `shrk apply --validate`. Only the
  locally-configured `sharkcraft.config.ts verificationCommands[]` is
  trusted as runnable.
- Packs may ship signed manifests. Sign with `shrk packs sign`, verify with
  `shrk packs verify`. Consumers can require signatures via
  `shrk packs doctor --require-signatures`.
- The CLI is the only write path; MCP tools are read-only.

## Pack contribution test

```bash
shrk packs test <path>                       # structural validation only
shrk packs test <path> --require-signature
shrk packs test <path> --load                # imports + validates exports
shrk packs test <path> --trusted-load        # also runs template renderers with default vars
```

`--load` actually imports the pack's TypeScript assets, asserts that each
exports an array, and that every item has a string `id`. It also checks
that pipelines declare steps.

`--trusted-load` additionally runs each template's `targetPath()` and
`content()` with synthesized default variables — useful for catching
renderers that throw when fed unexpected inputs. As the flag name says:
this evaluates pack code. Only run it on packs you trust.

Safety: even with `--trusted-load`, SharkCraft does not execute pack shell
commands, does not run lifecycle scripts, and does not touch the network.
The loader uses dynamic `import()` of local files only.

Direct TypeScript loading requires Bun. Under Node, `--load` reports the
limitation as a warning and falls back to the structural-only path.

## Release check (R13 / R14)

```bash
shrk packs release-check <path-to-pack> [--json]
shrk packs doctor --release [--require-signatures] [--strict] [--json]   # R14
```

`packs release-check` runs every check a release reviewer would want
to see, with a single exit code:

- `package.json` exists and points at a signed manifest.
- Manifest passes `validatePackManifest`.
- Every contribution file actually exists.
- Every contribution file imports cleanly (`*.ts` / `*.js` / `*.mjs` / `*.cjs`).
- The manifest has a HMAC signature (warning when absent).
- `package.json` `files[]` covers the signed manifest.

R14 ergonomics: each finding now includes `code`, `severity`, `file`,
`message`, an optional `suggestedFix`, and an optional copy-pasteable
`suggestedCommand` (for example, `shrk packs sign … --verify-after-sign`
for an unsigned manifest, or `shrk packs compat <path>` for helper-missing
import errors).

Use `shrk packs release-check` as the last gate before tagging. MCP
exposes the same payload via `get_pack_release_check`.

`shrk packs doctor --release` folds these findings into the existing
doctor report. New issue codes:

- `release-manifest-issue`
- `release-contribution-issue`
- `release-signature-issue`
- `release-files-issue`
- `release-readiness-issue`

`--strict` escalates release-check warnings into errors so a single
green/red gate covers the whole pre-tag readiness story. MCP exposes
the merged report via `get_pack_doctor_release`.

## Structural exports for backwards compatibility (R14)

When a pack imports a helper like `defineScaffoldPatterns` from
`@shrkcrft/plugin-api`, the helper must be present in the version of
`@shrkcrft/plugin-api` the consumer has installed. If a consumer's
pinned version pre-dates the helper, the contribution fails to load with
"`Export named 'X' not found in module '@shrkcrft/plugin-api'`".

R14 surfaces this as a `contribution-helper-missing` finding with three
fix options:

1. Bump `@shrkcrft/plugin-api` to a version that ships the helper.
2. Declare a `peerDependencies."@shrkcrft/plugin-api"` range that
   includes the helper.
3. Drop the helper import and ship a plain `export default ([...])`
   structural array. SharkCraft loads pack contributions by reading the
   default export, so structural arrays work against every plugin-api
   version.

`shrk packs compat <path>` reads the pack with the current
`@shrkcrft/plugin-api` and reports helper-missing diagnostics with the
same suggested-fix shape — useful as a quick "will this pack load on a
6-month-old consumer?" check.

### Plugin-api symbol diff (R15)

```bash
shrk packs compat <path-to-pack> --consumer-root <path>
shrk packs compat <path-to-pack> --consumer-root <path> --json
```

R15 extends `packs compat` with a symbol-level diff:

1. Walks the pack's contribution files and extracts every named import
   from `@shrkcrft/plugin-api`.
2. Resolves the consumer's installed `@shrkcrft/plugin-api` (or the
   pack's own `node_modules` copy as a fallback).
3. Collects the consumer's exported symbols by scanning the source /
   `dist/*.d.ts` / `dist/*.js`.
4. Reports each imported symbol as `available` or `missing`.

When `missing` symbols are found, the suggested-fix block lists four
options:

1. Bump `@shrkcrft/plugin-api` in the consumer workspace.
2. Widen `peerDependencies."@shrkcrft/plugin-api"` only if the symbols
   are stable across the range.
3. Replace the helper imports with plain structural object literals.
4. Drop the helper import entirely if the contributions no longer need it.

MCP: `get_pack_compat_report` returns the same payload server-side.
