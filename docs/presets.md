# Presets

A **preset** is a reusable SharkCraft project setup. Each preset bundles
knowledge, rules, paths, templates, pipelines, and docs that fit a specific
kind of project (TypeScript library, Bun service, Nx monorepo, …) and tells
the human what commands to run next.

Presets are not packs. Packs are *distributable* npm packages; presets are
*applicable* setups. Packs can contribute presets — that's how
external packs ship project-specific workflows.

> Presets are applied through the CLI. **MCP never writes** — the
> `preview_preset_application` tool returns the exact `shrk` command for a
> human to run.

## Built-in presets

| id | when to use |
|---|---|
| `generic` | Universal SharkCraft starter. Default for `shrk init`. |
| `typescript-library` | Strict-typing library: I-prefix, one-export, no logic in constructors. |
| `bun-service` | Bun-native HTTP service. |
| `node-api` | Framework-agnostic Node/Nest/Express API. |
| `frontend-app` | Framework-neutral frontend app baseline. |
| `nx-monorepo` | Layer order + public-entrypoint rules for Nx workspaces. |
| `mcp-server` | MCP server projects: no writes, zod-validate inputs. |
| `ai-agent-ready` | Action-hint-heavy baseline for Claude Code / Cursor. |
| `safe-codegen` | Plan-first generation + signed plans. |
| `testing-focused` | Unit/integration/mutation testing guidance. |

### R47 canonical aliases

R47 adds two aliases so the canonical-id you type matches the
ecosystem convention:

| id | composes | use case |
|---|---|---|
| `nest-service` | `nestjs-service` → `node-service` → `strict-typescript` → `generic-safe-repo` | A NestJS service (`shrk init --preset nest-service`) |
| `angular-app` | `modern-angular` → `strict-typescript` → `generic-safe-repo` | A modern Angular app (signals-first, OnPush, standalone) |

Both aliases inherit their `appliesTo` chain so `shrk init --preset
auto` picks them automatically for matching repos.

### NestJS auto-pick gotcha

NestJS services often ship with `main` set in `package.json`
(pointing at the compiled entry). The SharkCraft profile detector
treats `main / exports / types` as the `IsLibrary` signal, and the
`IsService` profile is intentionally excluded when `IsLibrary` is
present. The net effect: a NestJS package.json with `main` set may
be picked as `typescript-library` instead of `nest-service`.

Two ways to fix:

1. Drop `main` from `package.json` if the package is genuinely a
   service (not consumed as a library).
2. Apply the `nest-service` preset explicitly:
   `shrk init --preset nest-service --write`.

This is documented because the R47 dogfood encountered it in
`examples/adoption-nest-service/`.

Pack-contributed presets (e.g. from `@your-org/sharkcraft-pack`) appear
alongside the built-ins after the pack is installed:

```bash
shrk packs list                                    # confirm pack discovered
shrk presets list                                  # see pack presets [pack:<name>]
```

## Commands

```bash
shrk presets list                                  # built-in + pack-contributed
shrk presets get <id>                              # full details + counts
shrk presets explain <id>                          # R47: natural-language "when to use" view
shrk presets recommend                             # rank by detected profile
shrk presets preview <id> [--force] [--merge]      # what would be written
shrk presets apply <id> [--write] [--force] [--merge]
shrk presets doctor <id>                           # is the repo conforming?
```

`apply` is **dry-run by default**. With `--write` it persists files. Existing
files are skipped unless `--force` (overwrite) or `--merge` (append).

## Apply via init

```bash
shrk init                                          # generic preset by default
shrk init --preset typescript-library
shrk init --preset nx-monorepo --force
shrk init --suggest-only                           # just show recommendations
shrk init --legacy                                 # original pre-preset full seed
```

## Composition

Presets compose other presets via `composes: [...]`. Resolution is
recursive, cycle-detected, and deduped. The **root** preset wins on
duplicates — composed presets only contribute things the root doesn't
already define.

```ts
definePreset({
  id: 'feature-dev',
  composes: ['ai-agent-ready', 'safe-codegen'],
  includes: {
    // Project-specific assets only — composed presets give us the safety baseline.
    pipelineIds: ['feature-dev'],
    templateIds: ['app.service'],
  },
});
```

Inspect the composition chain:

```bash
shrk presets get feature-dev
# →   composed from   feature-dev → ai-agent-ready → safe-codegen
```

## References to existing assets

A preset can reference assets the inspection already has (built-in,
local, or pack-contributed) instead of duplicating TS source. Five
optional id arrays:

```ts
includes: {
  knowledgeIds:       ['agent.briefing'],
  ruleIds:            ['repo.architecture.respect-boundaries'],
  pathConventionIds:  ['app.services'],
  templateIds:        ['app.service'],
  pipelineIds:        ['feature-dev'],
}
```

References are resolved against the current inspection registries.
`shrk presets get/preview/diff` lists each as **OK** (resolved) or
**MISSING** (not present — install the pack that ships it or add it
locally). Referenced assets are **not** written to disk; only embedded
`knowledge` / `rules` / `paths` / `templates` / `pipelines` and
`docs` / `tasks` produce files.

## Diff and patch

```bash
shrk presets diff <id>                                # what's missing
shrk presets patch <id> --write                       # write missing pieces only
shrk presets apply <id> --write [--force] [--merge]   # full apply
```

`patch` never overwrites existing files. `apply --force` does. `apply --merge`
appends to mergable file kinds (knowledge/rules/paths/templates/pipelines).

## Authoring presets

```ts
// my-pack/src/assets/presets.ts
import { definePreset } from '@shrkcrft/presets';

export default [
  definePreset({
    id: 'my-team-baseline',
    title: 'My team baseline',
    description: 'Rules + paths + pipelines my org uses on every repo.',
    tags: ['internal'],
    appliesTo: ['has-typescript'],
    weight: 8,
    includes: {
      rules: [`defineKnowledgeEntry({ ... })`],
      paths: [`defineKnowledgeEntry({ ... })`],
      pipelines: [`definePipeline({ ... })`],
    },
    recommendedNextCommands: ['shrk doctor', 'shrk task "<task>"'],
  }),
];
```

The `includes` arrays hold **raw TypeScript source strings** that are
injected verbatim into the synthesized `sharkcraft/<knowledge|rules|…>.ts`
files. SharkCraft itself imports the produced files — same trust model as
`vite.config.ts`.

Ship the file by adding it to the pack manifest:

```ts
// my-pack/src/sharkcraft.plugin.ts
export default definePackManifest({
  schema: 'sharkcraft.pack/v1',
  info: { name: '@my-org/sharkcraft-pack', version: '0.1.0' },
  contributions: { presetFiles: ['./src/assets/presets.ts'] },
});
```

## Profile detection

`shrk presets recommend` ranks presets by the workspace profile tags
SharkCraft detects (`has-bun`, `has-typescript`, `is-monorepo`, …). See
`packages/workspace/src/profile-detector.ts` for the full list. Add a
preset's `appliesTo` to opt into the same profiles, and `notAppropriateFor`
to opt out.
