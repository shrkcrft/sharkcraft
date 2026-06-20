# `shrk start-here`

The human entry point. SharkCraft ships 380+ catalog entries; this is the
screen that gets a new consumer to their first productive command in 30
seconds.

> **R41 note.** The canonical "which command first?" reference is
> [`docs/command-entrypoints.md`](command-entrypoints.md). This page
> covers the orientation flows; that one covers the discovery surfaces
> (`shrk commands primary` / `surface` / `machine` / `legacy` /
> `overlaps`) and the recommended first-five lists for humans and
> agents.

> **R45 (Universal Adoption) note.** New entry points to lower the
> adoption floor for any TypeScript repo:
>
> - `shrk init --zero-config` — detect the workspace and pick a preset
>   automatically (default dry-run; `--write` persists).
> - `shrk ci scaffold github-actions --quickstart` — one-flag PR-checks
>   pipeline (doctor + changed-only boundaries + conditional gates).
> - `shrk rules lint [--fix-preview]` — lint rules with smallest-change
>   suggestions under `.sharkcraft/fixes/rules-lint/`.
> - `shrk eslint scaffold|report` and `shrk biome scaffold` — bridges
>   so existing-linter teams can still consume SharkCraft findings.
> - `shrk ide file <path> --json` — single-shot per-file data surface
>   for IDE extensions.

> **R47 (Universal Adoption top-5) note.** R45 built the floor; R47
> fills the gaps so a brand-new TypeScript project gets useful value
> in under 60 seconds. Added surfaces:
>
> - `shrk inspect --no-config` and `shrk doctor --no-config` — both
>   tolerate a missing `sharkcraft/` folder loudly enough to be
>   useful: the verdict line is advisory and the exit code stays 0.
> - `shrk inspect` and `shrk init --zero-config` now print a
>   structured **Detected** block (workspace flavor, configs, scripts,
>   recommended preset, "not guessed" honesty line).
> - Two canonical preset aliases: `nest-service` and `angular-app`.
> - `shrk presets explain <id>` — natural-language "when to use this
>   preset" view with the composition chain.
> - `shrk eslint rules` + `shrk eslint explain-limitations` — honest
>   inventory of what does / does not bridge to ESLint.
> - `shrk biome report` + `shrk biome explain-limitations` —
>   adjacent (not native) Biome diagnostics + limitation list.
> - `shrk checks import|aggregate|report|convert` — the universal
>   check-result protocol (`sharkcraft.check-result/v1`) that lets
>   SharkCraft aggregate its own findings + ESLint + Biome + custom
>   checks into one rollup. See
>   [`docs/check-result-protocol.md`](check-result-protocol.md).
> - `shrk ci scaffold github-actions --quickstart` now labels the
>   "exact path", "next command", and "Explanation of gates" so the
>   dry-run is self-documenting.

```bash
shrk start-here                       # default — list all 7 flows
shrk start-here --flow onboard        # one flow
shrk start-here --json                # machine-readable
```

## R38 — entrypoint matrix

If "which entrypoint should I use?" is the question, run
`shrk commands entrypoints` (alias: `shrk commands workflows`). It
classifies every "get me context" / "what should I do?" surface into
four classes:

| Class | When you reach for it | First call |
| --- | --- | --- |
| `human-interactive` | TTY human, "what should I do?" | `shrk recommend "<task>"` |
| `agent-mcp` | An AI agent's first MCP call | `prepare_agent_task` |
| `machine-json` | You want JSON to pipe into another tool | `shrk task "<task>" --json` |
| `debug-explainability` | Ranker / boundary / dispatch debugging | `shrk explain <id>` / `shrk graph why` / `shrk apply --explain-dispatch` |

`shrk task`, `shrk context`, and `shrk recommend` each print a one-line
banner with their class so the operator sees which surface they
reached. R39 extends the banner pattern to `shrk search` and the
ranker-debug entrypoint so registry-search and explainability can't be
mistaken for "what should I do?".

## R39 — friction polish

R39 doesn't add a new feature family. It rounds the corners so
SharkCraft is easier to trust:

| Surface | Why R39 cares |
| --- | --- |
| `shrk schemas inventory` | Engine schema-id inventory: known versions, current, deprecated/back-compat status (e.g. `self-config-doctor/v1` + `v2`). Replaces grepping the codebase. See [`docs/schemas-inventory.md`](schemas-inventory.md). |
| `shrk explore <path>` / `shrk architecture area <path>` | Workspace-aware "explain this directory" — area kind, key modules, related commands/MCP tools, tests, conventions, common edit risks. See [`docs/explore.md`](explore.md). |
| `shrk changes summary --round R39` | Optional `--round` label captured on the report for cross-round comparison. |
| `shrk changes acceptance-replay` | Read-only "given these changes, here are the previous validation commands to re-run", with reasons — no execution. See [`docs/acceptance-replay.md`](acceptance-replay.md). |
| `shrk context --task "rename X"` | Auto-promotes commands-first when the task verb is action-like (rename / add / fix / refactor / etc.). Pass `--full` to see the long context body. |
| `shrk doctor` fix-preview pointer | When doctor flags a preview-eligible warning, the footer points at `shrk fix preview` for a draft patch under `.sharkcraft/fixes/`. |

## The five primary flows

1. **Onboard an existing repo** — `shrk onboard --dry-run`, then
   `shrk onboard --write-drafts --scaffold-templates`. Writes only inside
   `sharkcraft/onboarding/`.
2. **Prepare an AI agent brief** — `shrk brief "<task>"`. Read-only.
3. **Start a safe dev workflow** — `shrk dev start "<task>" --brief`. Tracked
   session under `.sharkcraft/sessions/<id>/`.
4. **Review a PR / change** — `shrk impact`, `shrk review packet --v3`,
   `shrk report site`. Read-only.
5. **Run governance / quality checks** — `shrk quality`, `shrk safety audit`,
   `shrk commands doctor`, `shrk runtime doctor`, `shrk release readiness`.

## Optional flows

6. **Build a pack** — `shrk packs new`, `packs doctor --release`,
   `packs release-check`, `packs compat --consumer-root <path>`.
7. **Prepare a release** — `shrk release readiness`, `bun run release:preflight`.

## Primary commands

```bash
shrk commands
```

This is the curated short list — the eleven commands that handle 80% of
adoption. Use `shrk commands` (or `shrk commands search <q>`) for the
exhaustive catalog.

## MCP

`get_start_here` and `get_primary_commands` are the read-only MCP tools that
return the same data programmatically.

## Where this lives in code

- `packages/inspector/src/start-here.ts` — pure-data builder.
- `packages/cli/src/commands/start-here.command.ts` — CLI.
- `packages/mcp-server/src/tools/start-here.tool.ts` — MCP.
