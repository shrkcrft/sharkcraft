# CLAUDE.md

This file briefs Claude Code (and any agent that loads `CLAUDE.md`) on the
SharkCraft repository. Keep it short; deep details live in `docs/` and behind
the `shrk` CLI.

---

## What this repo is

SharkCraft is a deterministic, local-first toolkit that gives AI coding agents
durable project context. It ships as:

- A CLI (`shrk`) — the only write path.
- An MCP server — read-only by design.
- A library of structured assets (knowledge, rules, paths, templates,
  pipelines, presets, boundaries) that the CLI/MCP both consume.

**No AI inside the engine.** Every output is a function of the workspace +
the asset registries. The agent uses the engine; the engine never calls a
model.

---

## Repo layout

Nx-style monorepo. Each package is `packages/<name>` and publishes from
`packages/<name>/dist`.

```
packages/
  core/         shared types, errors, results, IDs
  workspace/    package.json / framework / profile detectors
  config/       sharkcraft.config.ts loader (zod-validated)
  knowledge/    knowledge entry model + loaders (TS / Markdown)
  rules/ paths/ templates/ pipelines/ presets/ boundaries/
                domain registries + recommenders
  packs/        pack discovery + signed-manifest verifier
  generator/    plan → review → apply pipeline + HMAC plan signing
  importer/     AGENTS.md / CLAUDE.md / .cursor/rules parsers
  inspector/    aggregate inspection + doctor + task packet +
                ranker + readiness + onboarding inference
  mcp-server/   read-only MCP tools (no writes, ever)
  cli/          the `shrk` command surface
  ai/           thin context-formatting helpers
  plugin-api/   pack contract types
  shared/       tiny shared utilities
examples/
  unconfigured-bun-service/  dogfood target for `shrk onboard`
  dogfood-target/            integration-test target for everything else
docs/           authoritative guides (overview / philosophy / per-feature)
scripts/        release-preflight / build-dist / publish-* tooling
```

### Layer order (lower → higher; lower cannot import higher)

```
core → workspace → config → knowledge → rules/paths/templates/pipelines/presets/boundaries
     → packs → generator → importer → inspector → mcp-server → cli
```

`shared/` and `ai/` sit at the edges and only depend on `core` (+ a few stable
peers). Run `bun run check:circular-deps` if a change spans multiple
packages.

---

## Commands

```bash
bun install
shrk <command>                   # CLI (installed globally; use directly)
bun run mcp                      # MCP server (stdio)
bun test                         # full test suite
bun x tsc -p tsconfig.base.json --noEmit
bun run build:dist               # per-package dist/
bun run release:preflight        # the gate before tagging
```

CLI bootstrap commands the agent should know:

```bash
shrk doctor                      # config + entry validation
shrk context --task "<task>"     # focused context for a task (deterministic)
shrk task "<task>"               # full task packet (rules + templates + pipelines + commands)
shrk coverage                    # what's still missing
shrk check boundaries            # boundary enforcement (with tsconfig alias support)
shrk finish                      # composite "safe to finish?" — runs boundaries+wiring+policy+orphans changed-only → one verdict
shrk check orphans               # after a delete: surviving importers of removed files/exports (alias-resolved)
shrk wiring chain|unprovided|orphans  # registration/DI graph: declared→provided→consumed (the silent-at-runtime bugs imports can't see)
shrk gates check|coverage|list|explain|try  # run every rule plane (one exit code) · what each MATCHED (stale-selector detector) · dry-run a rule
shrk baseline check|diff|update  # committed-ledger drift, two-way (a LOST entry fails like a gained one)
shrk generated check|update      # generated files: hand-edit drift (regen→temp→diff) + "do not edit" headers
shrk policy-lint [explain <id>]  # forbidden content the compiler never sees (inline templates, .scss, JSON)
shrk docs references check       # ids cited in PROSE (READMEs, docs, agent skill files) that no longer resolve
shrk registry <name> duplicates  # ids declared in >1 place — load-order roulette the compiler can't see
shrk explain <ruleId>            # one entrypoint: resolves a rule id across EVERY plane
shrk check wiring --fix [--write]  # deterministic autofix, unambiguous cases only; adds the import too when derivable, else refuses (needs-import)
shrk graph why <a> <b>           # shortest-path explanation between two graph nodes
shrk onboard --dry-run           # onboard an existing repo (advisory)
shrk stats                       # per-language file counts, LOC, sizes, averages
shrk dashboard                   # local read-only dashboard (127.0.0.1:4567)
shrk compress <file|->           # deterministically shrink a blob (JSON→table, log/diff/search→signal); CCR-reversible
shrk expand <ccr-key>            # retrieve a CCR-cached original (the reverse of compress)
```

## The gate planes (`docs/gate-rules.md`)

Seven data-defined planes in `sharkcraft.config.ts` cover what a green build
cannot see. `shrk gates check` runs them all in one pass (the CI / pre-commit
primitive); `--changed-only` scopes by rule footprint.

| Plane | Catches |
|---|---|
| `wiringRules[]` | declared here → never registered there |
| `policyRules[]` | forbidden content in non-compiled artifacts |
| `registries[]` | one id declared in two places (load-order roulette) |
| `registrationGraph[]` | declared → provided → consumed, end to end |
| `baselines[]` | a committed ledger that silently drifted (two-way: a LOST entry fails like a gained one) |
| `generatedArtifacts[]` | a hand-edited generated file, and missing "do not edit" headers |
| `docReferences[]` | an id cited in free-text prose that no longer resolves (`docs/doc-references.md`) |

The first six share one extraction DSL (`docs/extraction-dsl.md`). Key
behaviours, each with a reason worth remembering:

- **A rule matching nothing is a bug in the rule, never a pass.** `gates
  coverage` reports what every rule actually matched and flags every rule
  matching 0. `failOnEmpty` defaults **TRUE** for `error`-severity rules.
- **Exit codes.** `0` clean · `1` violations · `2` ran but proved nothing
  (empty scope, or ANY rule skipped) · `3` usage error. A skipped rule is never
  masked by a passing sibling, and an ERRORED rule is never `evaluated` — a
  rule that could not run is not a green whatever its severity. Every `--json`
  carries a shared `gate` envelope (`docs/gate-json.md`).
- **`import-edges`** makes the dependency graph a rule input (`emit:
  edge|symbol|from`), so existing planes express adoption ledgers, orphan
  detection, deprecation ratchets and targeted fences. Alias-aware, no persisted
  index. Target by `to.module` + `to.match` when consumers import through a
  barrel — `to.files` matches the DIRECTLY-resolved path, so a barrel
  re-exported symbol resolves to the package entry, not the deep file.
- **`$use` shared extractors.** A top-level `extractors` map defines a selector
  once; any plane references it with `{ $use: "<id>" }` (local fields override).
  A typo'd id fails the config load — never a source that silently matches
  nothing.
- **Mixed generated trees.** `generatedArtifacts[]` takes `sources[]` (N
  writers) and `handMaintained[]` (literal filenames only, so the exemption
  cannot silently widen), plus `handMaintainedMarker` for an in-file bless. A
  file owned by neither is an `unclassified` finding.
- **`--fix` never writes a non-compiling edit.** When a sink IMPORTS its array
  members, appending the token alone would green the gate over a file that no
  longer compiles. It adds the import when the specifier is a pure function of
  the member name AND resolves to the declaring file; otherwise it refuses with
  `needs-import`. `gates check --strict` promotes warnings to failures.
- **Shell-executing planes are local-config-only.** `baselines[].compute.run`
  and `generatedArtifacts[].regen` spawn a shell, so the pack-plane merge seam
  DROPS any pack-contributed element carrying one — mirroring the
  "pack-contributed verification commands are NOT auto-run" contract.

## Invariants that bite (learned the hard way)

Three rounds fixed the same shape: **two code paths answering one question,
agreeing only by coincidence.** Before adding a second way to answer something,
look for the existing authority.

- **One id resolver.** `packages/inspector/src/reference-registry.ts` answers
  "does this id exist?" for every kind — the prose linter, a knowledge entry's
  structured `references[]`, and both self-config doctors read it. Each kind
  reads the same source its `list` verb reads (`template` goes through
  `templateRegistry`, because that is what `shrk templates list` prints).
  `r73-one-reference-resolver.test.ts` holds `list ≡ resolve` across all 17
  kinds.
- **Never cast an inspection to a registry shape it may not have.**
  `(inspection as { fooRegistry?: … }).fooRegistry` type-checks and then answers
  "nothing exists" forever, including for correct ids. Five call sites did this;
  a grep lock now fails the build if it returns. Use the registry accessors.
- **Warm before you resolve.** `playbook`, `construct`, `policy`, `helper`,
  `convention`, `contract-template`, `migration-profile`, `routing-hint`,
  `registration-hint` and `scaffold-pattern` ids come from an async-filled
  cache; the resolver is sync. Call `warmReferenceRegistries(inspection)` first.
- **Freshness is divergence, never age.** An index built five days ago with a
  clean tree is *current*; one built a minute ago with a changed file is not.
  `detectGraphFreshness` is the one authority; `graph status`, `code-intel`,
  `doctor` and the MCP tool all consume it. It lives in `@shrkcrft/graph`
  (above `inspector`), so it is **injected** — `runDoctor(inspection, {
  graphDivergence })`.
- **Loud-skip anything DERIVED from a stale input.** A count from a stale index
  misses real findings AND reports fixed ones, so it is reported `NOT VERIFIED`
  rather than as a number. An unmeasured verdict is never a pass.
- **A test that invents the shape it tests proves nothing.** Two fixtures
  supplied a `playbookRegistry` production never supplies; that fake is why the
  bug shipped. Fixtures load real registries.

## Token compression (`docs/compression.md`)

`@shrkcrft/compress` cuts the tokens an agent pays for the same information —
deterministic, no model. MCP responses are minified valid JSON;
`get_knowledge_graph format:"table"` and `compress_context` hoist/columnarise or
line-reduce blobs. Lossy passes cache the original (Compress-Cache-Retrieve) and
emit a `<<ccr:KEY>>` marker recoverable via `retrieve_original` / `shrk expand`.

## Local-LLM enrichment (`docs/smart-context.md`)

Opt-in, and **local-only by default**. `AI_PROVIDER=auto` walks
`llamacpp → ollama` and never reaches a hosted model. Hosted Claude/Gemini
providers exist but are explicit opt-in (`AI_PROVIDER=claude|gemini` or
`--provider`, plus an API key) because they send repo context off-machine.

```bash
shrk smart-context "<task>"              # fast brief (draft → polish)
shrk smart-context "<task>" --plus       # full pipeline (draft → critique → refine → polish)
shrk smart-context "<task>" --budget 60  # cap enhancement wall-clock
shrk smart-context "<task>" --plan --save
shrk smart-context plan-ahead "t1" "t2"  # pre-plan a multi-task queue
```

The engine stays deterministic; the LLM only refines its output, and every run
is wall-clock-bounded — a model too slow for the budget degrades to the best
output so far rather than hanging. With no LLM reachable every command still
works against the deterministic seed. Point at a remote box with `OLLAMA_HOST` +
`OLLAMA_MODEL`, or in-process with `LLAMACPP_MODEL_PATH`.

**This file is part of the seed** — editing it changes what the local model
sees. For the agent workflow, use the `shrk-smart-context` skill.

---

## Coding standards (enforced as project policy)

- **TypeScript first.** Strict mode on. Interfaces prefixed with `I`. Enums
  preferred over union literals for closed sets.
- **One exported top-level construct per file** (one class OR interface OR
  enum OR type).
- **No logic in constructors** — initialization belongs in explicit lifecycle
  methods.
- **Absolute imports via package names only** — no relative imports across
  package boundaries.
- **Layer order is strict** — lower layers cannot import higher.
- **Errors flow through Result + AppErrorImpl** (`packages/core`), not
  exceptions, on public APIs.

---

## Safety contracts (do not break)

- **MCP never writes.** Every MCP tool is read-only. Even onboarding,
  apply, and generation return next-command hints — the human runs the
  write step on the CLI.
- **Apply requires `--verify-signature` for signed plans** and refuses on
  divergence unless `--allow-divergent` is set.
- **Pack-contributed verification commands are NOT auto-run.** Only commands
  in `sharkcraft.config.ts verificationCommands[]` are eligible for
  `shrk apply --validate --verification <id>`.
- **`shrk onboard --write-drafts` only writes under
  `sharkcraft/onboarding/`.** It never overwrites `rules.ts`, `paths.ts`, or
  `templates.ts`.

---

## When in doubt

- `docs/overview.md` — what SharkCraft is and isn't.
- `docs/philosophy.md` — the non-negotiable design rules.
- `docs/onboarding.md` + `docs/inference.md` — the onboarding engine.
- `docs/security.md` — pack signing + apply guarantees.
- `docs/gate-rules.md` — the trust layer over every data-defined rule plane.
- `docs/extraction-dsl.md` — the shared id-extraction primitive.
- `docs/gate-json.md` — the one `--json` envelope across every gate verb.
- `docs/release-checklist.md` — the preflight gate.

For day-to-day work, **invoke the `sharkcraft-dev` skill** — it walks you
through bootstrapping a session deterministically.
