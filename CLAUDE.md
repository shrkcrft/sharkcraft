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
shrk knowledge stale-check       # verified / stale / UNVERIFIABLE entries — strict: any unverifiable entry → 2 unless --min-referenced accepts it
shrk check boundaries            # boundary enforcement (with tsconfig alias support)
shrk finish                      # composite "safe to finish?" — runs boundaries+wiring+policy+orphans changed-only → one verdict
shrk check orphans               # after a delete: surviving importers of removed files/exports (alias-resolved)
shrk wiring chain|unprovided|orphans  # registration/DI graph: declared→provided→consumed (the silent-at-runtime bugs imports can't see)
shrk gates check|coverage|list|explain|try|scaffold-selftest  # run every rule plane (one exit code) · what each MATCHED (stale-selector detector) · dry-run a rule · write a rule's selfTest from what it matches today
shrk quality                     # THE "before you push" gate: every check + every rule plane, exhaustive, each failure with its repro command
shrk graph importers <module>    # every module importing this one — alias/type-only/re-export aware (what `callers` cannot see)
shrk reuse "<intent>"            # intent → the construct to reuse: curated reusePrimitives[] + the uncurated public export surface (labelled)
shrk reuse coverage              # curated index vs the public surface: dead entries, bad importPaths, curation gaps; exit 2 on a stale index
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

- **Dispatcher contract** (`docs/command-discovery.md`). A wrong invocation never
  reads as success: an unknown subcommand or a bare token under a group is
  refused before any body runs, and so is an unknown flag — outside a declared
  set, or named by none of the command's documentation (usage, index, the
  two-way-locked `UNDOCUMENTED_FLAG_READS` ledger) — naming the closest match;
  `3` on a verdict verb (`usageExitFor` over `GATE_VERB_PATHS`), `2` elsewhere.
  ONE judgement (`judgeInvocation`) serves the dispatcher and the command-string
  resolver, so a string the resolver certifies is one the dispatcher runs.
  `--help` / `-h` anywhere before `--` prints help and never runs a body. Global
  flags (`dispatch/global-flags.ts`, THE list; one pre-dispatch strip,
  `stripPreDispatchGlobals`) work leading, in-path or trailing.
- **Audience gate** (`docs/surface-tiers.md`). Commands that maintain SharkCraft
  itself (`docs check`, `release readiness`, `self audit`, `commands doctor`, …)
  are `tool-maintenance`: outside this repo they are hidden from `--help` and
  exit `78` via the surface gate — never a check failure. `surface.enabled` is
  the escape hatch; `surface.disabled` (`shrk surface deny`) refuses a command
  the same way.

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
| `baselines[]` | a committed ledger that silently drifted (two-way: a LOST entry fails like a gained one) · `mode: 'ceiling'` for a measured-number ratchet |
| `generatedArtifacts[]` | a hand-edited generated file, and missing "do not edit" headers |
| `docReferences[]` | an id cited in free-text prose that no longer resolves (`docs/doc-references.md`) |

The first six share one extraction DSL (`docs/extraction-dsl.md`). Key
behaviours, each with a reason worth remembering:

- **A rule matching nothing is a bug in the rule, never a pass.** `gates
  coverage` reports what every rule actually matched and flags every rule
  matching 0. `failOnEmpty` defaults **TRUE** for `error`-severity rules.
- **An empty result can be the intended one** (`docs/intended-empty.md`):
  per-unit `{ pattern, expectEmpty: true }` on every markable list, settled by
  ONE core authority (`settleUnitLiveness` / `settleRuleEmptiness`) into a
  printed acceptance; a marker whose target appears is reported as went-live.
- **Exit codes.** `0` clean · `1` violations · `2` ran but proved nothing
  (empty scope, or ANY rule skipped) · `3` usage error · `78` refused by the
  surface gate · `70` the tool's own install is broken (an unlinked workspace
  dependency, from the bin bootstrap) (`docs/exit-codes.md`). A skipped rule is never
  masked by a passing sibling, and an ERRORED rule is never `evaluated` — a
  rule that could not run is not a green whatever its severity. Every `--json`
  carries a shared `gate` envelope (`docs/gate-json.md`).
- **Coverage is a required part of every verdict.** Every envelope rule and the
  run carry `coverage {unit, expected, examined, capped?, …}` (`@shrkcrft/core`
  `IVerdictCoverage`); one guard (`settleVerdict`, inside `buildGateEnvelope`)
  turns a proposed `0` into `2` on any shortfall — a capped scan, an empty
  scope, or a subset wiring rule whose declared selector never produced a
  registered token (`partial`). Only an explicit, printed valve accepts a gap
  (`--allow-empty`, `registeredExtras`). Print a ✓ line only via `verdictLine`;
  a new verdict verb adds itself to `GATE_VERB_PATHS` or the r75 contract test
  fails — it holds every gate-envelope emitter AND every `settleVerdict(` call
  site (a two-way ledger: each file's verbs, or a reasoned exemption).
- **One reader, one scan scope.** `readMatchingFiles` returns the glob-matched
  files it did NOT read (over the 1MB cap, or unreadable), and every plane
  folds them into its rule coverage through `readScopeCoverage`
  (`examined N of M files, K over the 1MB read cap: <path>`). An unread file
  is never a pass and never `failOnEmpty`'s 1. Every plane walk, in a verb or
  an aggregate, prunes the same dirs via `planeScanExcludeDirs`.
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
- **`scan` — the lexical layer under every regex.** A raw-text rule matches file
  BYTES, so a pattern keyed on a code construct fires on a doc comment that
  merely describes it (a false failure) and a count extractor counts a word
  inside prose (a false green). `scan: code | strings | comments |
  code-and-templates` blanks the excluded zones with equal-length whitespace, so
  offsets stay true and EVERY extractor kind is zoned by one code path. One
  vocabulary across the policy plane and the extraction DSL. `json-path` /
  `filenames` reject it loudly rather than ignoring it.
- **`!` subtracts on every plane, through one parser.** `parseGlobList` (core)
  decides what `!` is; `globListSelects` (boundaries) is the one scope test — a
  path is selected iff an inclusion glob matches and no negation of THE SAME
  list does. Walks are positive-only unions (`readMatchingFiles`); select per
  list after (`readSelectedFiles` / `readScopeOfLists`), never over a flattened
  union, or one rule's `!x` hides x from another. A negation is dead only when it
  excludes nothing (`globListUnits`). On the boundary plane `!` EXEMPTS
  (suppressed, counted); on the gate planes it EXCLUDES. A bare `!`, `!!x` and a
  negation-only list are load errors.
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
  `r73-one-reference-resolver.test.ts` holds `list ≡ resolve` across all 18
  kinds. Every kind is also DECLARABLE: `REFERENCE_KIND_DECLARATIONS` (a
  `Record<IdReferenceKind, …>`) says how its ids come to exist, and r76 declares
  an id through every path and proves the resolver lists it. Field → kind
  bindings live in ONE table (`PROBED_ID_FIELDS`): `profileIds` bound to the
  wrong vocabulary (migration profiles) sat at NOT VERIFIED forever.
- **Never cast an inspection to a registry shape it may not have.**
  `(inspection as { fooRegistry?: … }).fooRegistry` type-checks and then answers
  "nothing exists" forever, including for correct ids. Five call sites did this;
  a grep lock now fails the build if it returns. Use the registry accessors.
- **Warm before you resolve.** `playbook`, `construct`, `policy`, `helper`,
  `convention`, `contract-template`, `migration-profile`, `routing-hint`,
  `registration-hint`, `scaffold-pattern` and TS-declared `decision`
  (`sharkcraft/decisions.ts`, pack `decisionFiles`) ids come from an
  async-filled cache; the resolver is sync. Call
  `warmReferenceRegistries(inspection)` first.
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
- **A loader never drops an entry silently.** Every contributed-asset loader
  returns `rejected: IRejectedEntry[]` next to its entries (accepted + rejected
  = declared, per file), and ONE channel carries them to every surface —
  `collectContributionRejections` over `collectRegistryOutcomes`
  (`packages/inspector/src/contribution-load-failures.ts`). A loader's
  acceptance predicate must cover every field its consumers dereference (an
  accepted step-less playbook crashed the self-config doctor), and `packs test
  --load` validates through the SAME predicates (`validateContributionFile`).
  The r76 census contributes one invalid entry to every loader-backed slot and
  asserts it on every surface.

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
