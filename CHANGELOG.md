# Changelog

All notable changes to SharkCraft are documented here. Format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and SharkCraft uses
[semver](https://semver.org/). During alpha, breaking changes can land in
any release — pin exact versions.

## [Unreleased — staged after 0.1.0-alpha.8] — One-shot code-intel view, round 8

After rounds 1–7 built and exposed every doctor check, gate signal,
and starter helper, this round adds a single concise surface that
collapses the 14 code-intelligence checks into one read — for the
inner loop, the dashboard, and any downstream tool that wants just
the code-intelligence section without `shrk doctor`'s wider output.

### Added — `shrk code-intel` top-level command

A focused alternative to `shrk doctor` that returns only the
`category: 'code-intelligence'` findings:

- Text mode (default) groups by severity with `✓ ℹ ⚠ ✗` icons,
  one line per finding plus its fix / `whyThisMatters`.
- `--json` emits `sharkcraft.code-intelligence-state/v1` with the
  summary counts + full check list.
- `--markdown` produces PR-ready output with summary table + per-
  check sections (counterpart to `shrk gate --markdown`).
- Filters: `--only ok,warning,error,info` and `--check <id>`.
- `--stale-days N` overrides the default freshness threshold (7).
- Exits 1 on any structural error; advisory warnings never fail
  (same contract as `shrk doctor`).

### Added — `get_code_intelligence_state` MCP tool

Read-only mirror of `shrk code-intel`. Returns the 14-check payload
under the same schema. Same `only` + `checkId` filter shape as the
CLI so agents have a single point of read for the entire code-
intelligence state.

### Why this round

`shrk doctor` reports everything — config, knowledge, templates,
pipelines, packs, code-intelligence, all in one frame. Inner-loop
callers usually want just the code-intelligence slice (especially
after a `shrk graph index --watch` tick). Adding a dedicated
command + MCP tool removes the parsing step that downstream tools
were doing anyway and locks in a stable schema for what "the
code-intelligence section" means.

## [Unreleased — staged after 0.1.0-alpha.8] — DX polish, round 7

After rounds 1–6 built out the code-intelligence layer end-to-end,
this round focuses on the **inner loop** an AI agent (or human) lives
in: live re-indexing, pre-commit gating, and tab-completion.

### Added — `shrk graph index --watch`

The graph indexer can now run in a watch loop. The first tick runs a
full or incremental index as normal; every subsequent tick forces
`--changed`, so a 5-file edit takes < 100 ms via the existing
incremental updater. Reuses the existing `maybeRunInWatchMode`
infrastructure for debounce + `--paths` filtering, so `--once` /
`--debounce N` work out of the box.

```bash
# Default: watch the entire project root.
shrk graph index --watch

# Narrow: only re-index when packages/cli or packages/inspector change.
shrk graph index --watch --paths packages/cli,packages/inspector --debounce 250
```

### Added — `shrk gate scaffold-hook`

Pre-commit hook scaffold for projects that want a faster feedback
loop than CI. Two flavours:

- `--provider husky` (default) writes `.husky/pre-commit` running
  `shrk graph index --changed && shrk gate --strict`. chmod 755.
- `--provider raw` writes `scripts/pre-commit` (chmod 755) and
  prints the `ln -s` activation hint. No husky dependency.

Refuses to overwrite without `--force`. Pairs with the round-6
`scaffold-ci` so a project can adopt both in two commands.

### Added — `shrk completion <bash|zsh|fish>`

Sourcable shell-completion scripts. Top-level verbs are pulled from
the runtime `COMMAND_CATALOG` so completion can't drift from what
the CLI actually accepts. Subverbs for the high-traffic groups
(`graph`, `arch`, `impact`, `gate`, `context`, `search-structural`,
`doctor`) are hand-curated.

```bash
# Bash:
eval "$(shrk completion bash)"

# Zsh:
eval "$(shrk completion zsh)"

# Fish (write once, lasts forever):
shrk completion fish > ~/.config/fish/completions/shrk.fish
```

JSON mode (`--json`) emits the verbs + subverb map under schema
`sharkcraft.cli-completion/v1` for editor / IDE integrations.

### Why this round

The new code-intelligence surfaces from rounds 1–6 only pay off in
the inner loop if they're cheap to invoke. `--watch` makes the
graph free; `scaffold-hook` makes the gate free; `completion` makes
the surface discoverable without reading docs. None of these add
schemas or new state files — they're pure DX.

## [Unreleased — staged after 0.1.0-alpha.8] — Code-intelligence doctor surface, round 6

Closes the read-only agent surface: every new state file introduced
across rounds 1–5 now has a matching MCP tool. Adds PR-comment-ready
markdown output for `shrk gate` and a one-shot CI workflow scaffold
so teams can adopt the gate in a single command.

### Added — 4 new MCP tools

- `get_graph_deps` — read-only mirror of `shrk graph deps <package>`;
  returns inbound + outbound `package-depends-on` edges. Structured
  `graph-missing` / `not-found` errors with `nextCommand` hints.
- `get_impact_baseline` — read-only mirror of `shrk impact baseline
  show`. States: `present` (baseline + last + delta), `missing-both`,
  `missing-baseline`, `missing-last` — each with `nextCommands`.
- `get_pattern_registry` — read-only mirror of `shrk search-structural
  registry list`. Reports `present: true|false` so the agent can
  detect a never-seeded registry.
- `get_intent_benchmark_run` — read-only mirror of `shrk context
  benchmark`. States: `present` (run + fixture case count),
  `fixture-only` (run yet to be persisted), `missing`.

All four are registered in `ALL_TOOLS`, advertise read-only intent
in their descriptions, and accept the standard MCP context. Sibling
pattern of the existing graph tools.

### Added — `shrk gate --markdown` (+ `--output <path>`)

`@shrkcrft/quality-gates` gains `renderGateReportMarkdown(report)`
that produces a PR-comment-ready markdown rendering:

- Header line with overall-status badge (✅ / ⚠️ / ❌ / ⏭️).
- Counts table.
- Per-gate section with status icon, label, duration, message,
  and a fenced bash code block of next commands when present.
- Diagnostics section appended only when non-empty.

`shrk gate --markdown` writes to stdout; `--output <path>` writes
to a file. Exit code mirrors the existing pass/warn/fail semantics.

### Added — `shrk gate scaffold-ci [--provider github|generic]`

One-shot CI runner generator:

- `--provider github` (default) → writes
  `.github/workflows/shrk-gate.yml` with `actions/checkout@v4` +
  `oven-sh/setup-bun@v2` + `shrk graph index` + `shrk gate
  --markdown --output gate-report.md` + an `actions/github-script`
  step that posts the markdown report as a PR comment.
- `--provider generic` → writes `scripts/shrk-gate.sh` (chmod 755)
  that any CI provider can invoke. Defaults to `--strict`.
- Refuses to overwrite without `--force`.

### Roadmap

The agent surface (CLI + MCP) is now feature-complete for every
code-intelligence state file shipped through rounds 1–6. The
remaining items on the roadmap are dashboard polish + framework
extractor additions — both demand-driven.

## [Unreleased — staged after 0.1.0-alpha.8] — Code-intelligence doctor surface, round 5

After rounds 1–4 closed every §5.5 doctor gap, this round wires the
new signals into the canonical CI gate (`shrk gate`), ships an
authoritative reference document, and adds zero-config starter
content so projects can adopt the new surfaces with a single command.

### Added — 5 new gates in `shrk gate`

`@shrkcrft/quality-gates` gains five new gate functions that read
the same on-disk state files as the doctor surfaces. Each is part
of the default gate set, configurable via the `runQualityGates`
options, and skippable via `disable`:

- `graph-cycles` — surfaces `largestCycleSize ≥ 3` OR
  `cycleCount ≥ 5`. Warn by default; `failOnLarge: true` escalates.
- `graph-unresolved` — surfaces any `unresolved:*` edges (count,
  affected files, sample specifiers). Warn by default; `failOnAny`
  escalates to fail.
- `impact-baseline` — diffs `last.json` against `baseline.json`,
  warns when dependents / packages / risk worsened. Skipped when
  either side is missing. `failOnWorsened` escalates.
- `structural-patterns` — re-validates the pattern registry; warns
  on any invalid entry. Skipped when no registry exists.
  `failOnInvalid` escalates.
- `intent-classifier` — runs the benchmark fixture in-process and
  gates on accuracy (default fail < 60%, warn < 95%). Skipped when
  no fixture exists.

All five are exported from `@shrkcrft/quality-gates` and registered
in `runQualityGates`. Existing CI runs see them via the next
`shrk gate` call; legacy behaviour is preserved when each is added
to the `disable` list.

### Added — `docs/doctor-code-intelligence.md`

Authoritative reference for all 14 code-intelligence doctor check
ids. Documents source file, trigger conditions, default severity,
fix commands and `whyThisMatters` rationale for every check.
Cross-linked from §5.5 of the roadmap. Closes the §5.7 docs
discipline promise for the code-intelligence layer.

### Added — Starter content (`registry seed` + `benchmark seed`)

Zero-config adoption helpers for the two opt-in features shipped in
round 4:

- `shrk search-structural registry seed` writes 7 curated starter
  patterns (`no-console-log`, `no-debugger`, `bare @Controller()`,
  `@Injectable()` finder, `eval()` smell, dynamic `require()`,
  cross-package `/internal/` imports) into the registry. Refuses
  to overwrite an existing non-empty registry without `--force`.
- `shrk context benchmark seed` writes a 21-case starter fixture
  to `sharkcraft/intent-benchmark.json` covering all six intent
  labels. The starter set achieves ≥ 90% accuracy on the current
  classifier (verified by tests).
- New public APIs: `STARTER_PATTERNS` from
  `@shrkcrft/structural-search` and `STARTER_INTENT_BENCHMARK`
  from `@shrkcrft/context-planner`.

### Roadmap

§5.5 is now "all-shipped + gated". Every doctor check has a
matching gate where shippability matters; every opt-in surface has
a starter; every check is documented in
`docs/doctor-code-intelligence.md`.

## [Unreleased — staged after 0.1.0-alpha.8] — Code-intelligence doctor surface, round 4

Closes the last two §5.5 doctor gaps (`@shrkcrft/structural-search` and
`@shrkcrft/context-planner`) plus adds a symmetric impact baseline,
two new MCP tools and one new CLI subverb. After this round the
roadmap §5.5 table reads "shipped" for every code-intelligence
package.

### Added — Pattern registry + structural-search doctor surface

`@shrkcrft/structural-search` gains a persistent registry of reusable
AST-shape patterns:

- `PatternRegistryStore` exported from `@shrkcrft/structural-search`.
  Reads/writes `.sharkcraft/structural/patterns.json` (schema
  `sharkcraft.structural-pattern-registry/v1`).
- `validatePatternEnvelope(envelope)` — light-weight envelope check
  (schema field, `pattern.kind` in `KNOWN_PATTERN_KINDS`, regex
  fields compile). Runs at registration time AND in `validateAll()`.
- CLI: `shrk search-structural registry <list|add|remove|validate|clear>`.
  `add --id <id> (--pattern <json> | --pattern-file <path>)` registers
  a reusable pattern; `validate` walks every entry and stamps
  `lastValidatedAt` / `lastValidationError`.
- Doctor surface `code-intelligence-structural-search`: `Warning` on
  any entry with `lastValidationError`; advisory `Info` for empty
  registry or unvalidated entries; OK when every entry is fresh.
- New schema in `EXPECTED_SCHEMAS` (so the cross-store
  schema-mismatch check covers the registry too).

### Added — Intent classifier benchmark + context-planner doctor surface

`@shrkcrft/context-planner` gains a labelled benchmark for the
keyword-based intent classifier:

- Schema `sharkcraft.intent-benchmark/v1` — author-checked-in
  fixture at `sharkcraft/intent-benchmark.json` (NOT under
  `.sharkcraft/`, which is derived). `cases: [{ task, expected, notes? }]`.
- `loadIntentBenchmark / runIntentBenchmark / writeBenchmarkRun /
  readBenchmarkRun` exported from `@shrkcrft/context-planner/intent/benchmark.ts`.
- CLI: `shrk context benchmark` runs the fixture and persists the
  result at `.sharkcraft/context-planner/intent-benchmark.json`.
  Exits 1 when any case fails; `--no-persist` opts out of the write.
- Doctor surface `code-intelligence-context-planner`: OK on 100%
  accuracy, `Warning` on any miss (with sample `expected → actual`
  failures). Advisory threshold at ≥80% — below that, the warning
  is non-advisory because the ranker is materially miscalibrated.

### Added — Symmetric impact baseline + delta

Mirrors the round-2 architecture baseline pattern:

- `ImpactReportStore.{readBaseline,writeBaseline,clearBaseline}` +
  `diffImpactReports(baseline, last) → { dependentDelta,
  packageDelta, riskDrift?, worsened }`.
- `shrk impact baseline <write|show|clear>` — `write` freezes the
  current `last.json` snapshot to `.sharkcraft/impact/baseline.json`;
  `show` prints the baseline + delta vs `last.json`; `clear` removes
  the baseline file.
- Doctor surface `code-intelligence-impact-baseline`: OK when last is
  within baseline; `Warning` when *any* of dependents / packages /
  risk worsened (with the explicit drift in the message).
- New schema in `EXPECTED_SCHEMAS` for the baseline file.

### Added — `get_graph_unresolved` MCP tool

Read-only MCP mirror of `shrk graph unresolved`. Groups every
unresolved import edge by source file, sorted by count desc.
Same safety contract as the existing graph tools (structured
`graph-missing` error with `nextCommand`). Registered in
`ALL_TOOLS`; sibling pattern of `get_graph_cycles`.

### Added — `shrk graph deps <package>` CLI

Package-level dependency view: lists inbound (packages that depend
on `<package>`) and outbound (packages `<package>` depends on)
edges from the persisted graph's `package-depends-on` relations.
Both text and JSON output. Useful counterpart to `shrk graph
importers` / `importsFrom` which operate at file granularity.

### Roadmap

`docs/roadmap-code-intelligence.md` §5.5 is now **all-shipped**: 14
check ids covering every code-intelligence package. Status snapshot
row updated to reflect the new surfaces (pattern registry, intent
benchmark, impact baseline, MCP unresolved, graph deps).

## [Unreleased — staged after 0.1.0-alpha.8] — Code-intelligence doctor surface, round 3

Continues the work in the round below. The earlier round added the
first five code-intelligence doctor checks (`-graph`, `-rule-graph`,
`-api-surface`, `-quality-gate`, `-migrations`) plus the
`-architecture` + `-rule-coverage` + `-graph-cycles` follow-ups in
the round after. This round closes most of the remaining §5.5 gaps:
unresolved-imports surface, persisted impact-run snapshot,
per-framework health, schema-version compatibility, and a public
`IGraphQueryApi.cycles()` + CLI subverb.

### Added — `IGraphQueryApi.cycles()` + `shrk graph cycles` CLI

The roadmap (§3.1) long-promised a query-time `cycles()` method on
the graph query API. Today, with `summarizeCycles` already used by
the indexer, the missing piece was the surface that returns the
*full* SCC list (not just a counter):

- `findFileCycles(nodes, edges, pathById?)` exported from
  `@shrkcrft/graph/query/cycle-detection.ts`. Iterative Tarjan SCC
  (stack-safe), sorted by size DESC then id ASC so callers get a
  stable "worst first" ordering. `summarizeCycles` is now a thin
  roll-up over this primitive.
- `GraphQueryApi.cycles(): readonly IFileCycle[]` recomputes from
  the in-memory snapshot and fills `paths` from the file nodes.
- `shrk graph cycles [--limit N] [--min-size N] [--json]` — text
  mode prints `#1 (size 4):\n  pkg/a.ts\n  pkg/b.ts\n  → pkg/a.ts\n…`,
  JSON returns `{ ok, total, truncated, cycles: [{size, paths}] }`.

### Added — Unresolved-import tracking in graph manifest + doctor

The indexer already created `unresolved:<specifier>` sentinel edges
when a relative / alias / workspace import couldn't be resolved on
disk — but nothing surfaced the count. Now:

- `IGraphManifest` carries optional `unresolvedImportCount`,
  `filesWithUnresolvedImports`, `unresolvedImportSamples` (≤10
  distinct specifiers).
- Both `buildFullIndex` and `updateChanged` populate via the new
  `summarizeUnresolvedImports(edges, sampleLimit?)` helper.
- `shrk graph index` and `shrk graph status` print
  `unresolved imports: N across M file(s)` when non-zero; JSON
  status adds the three fields.
- Doctor surface `code-intelligence-graph-unresolved` (regular
  `Warning`, not advisory) with first 3 sample specifiers + DX fix
  hint. Catches typos, deleted-but-still-imported modules, and
  alias renames the importer never followed.

### Added — Persisted impact runs (`sharkcraft.impact-run/v1`)

`shrk impact --via-graph` now writes a compact snapshot to
`.sharkcraft/impact/last.json` (overridable with `--no-persist`) so
the doctor / dashboard / CI can answer "what was the last impact
analysis" without re-running it.

- `ImpactReportStore` + `snapshotImpactAnalysis(analysis, summary)`
  exported from `@shrkcrft/impact-engine`. Snapshot keeps the
  counts, risk, validation scope, and a short `inputSummary`
  string — the full per-file lists stay out of the persisted file.
- Doctor surface `code-intelligence-impact`:
  - `risk = high|critical` → regular `Warning` listing direct +
    transitive counts, packages, recommended tests, public-API
    touch indicator.
  - Stale (`> 7d`) downgrades the warning to advisory.
  - `low|medium` → OK with same summary one-liner.

### Added — Per-framework health doctor surface

`code-intelligence-framework` reads `.sharkcraft/framework/meta.json`
(written by the framework-scanner pipeline) and surfaces a
per-framework breakdown (`nestjs=12, react=47, …`) in the doctor
message. OK on fresh; advisory `Warning` on stale; advisory `Info`
when the scan ran but found no entities (often a misconfigured
extractor); structural `Warning` on corrupt JSON.

### Added — `shrk graph unresolved` CLI subverb

Counterpart to `shrk graph cycles`: enumerates every `unresolved:*`
edge in the graph, grouped by source file and sorted by count desc.
Text mode prints one file per group with a bullet list of broken
specifiers; `--json` returns `{ totalEdges, totalFiles, truncated,
files: [{ path, unresolved: string[] }] }`. Closes the natural
counterpart to the new `code-intelligence-graph-unresolved` doctor
finding — the doctor flags that there are N broken imports, this
subverb tells you exactly where.

### Added — `get_graph_cycles` MCP tool

Read-only MCP mirror of `shrk graph cycles`. Returns the full SCC
list (sorted by size DESC) for agents that need "show me every
import cycle in this repo" in a single tool call. Same safety
contract as the other graph tools: structured `graph-missing` error
with `nextCommand: 'shrk graph index'` when the index isn't built
yet. Registered in `ALL_TOOLS`; sibling pattern of
`get_graph_callers`.

### Added — Cross-store schema-version compatibility check

`code-intelligence-schema-mismatch` aggregates every stored payload
whose top-level `schema` field doesn't match the inspector-side
`EXPECTED_SCHEMAS` table. Covers graph, bridge, api-surface cache,
quality-gate report, framework manifest, architecture baseline/last,
impact run, and migration state files. Single `Warning` with the
first three mismatches + a regenerate fix hint per affected store.
Closes the §5.1 roadmap promise that doctor validates compatibility
on every start.

### Roadmap

`docs/roadmap-code-intelligence.md` §5.5 table refreshed: only
`@shrkcrft/structural-search` and `@shrkcrft/context-planner` remain
without doctor surfaces (both need persistence layers that don't
exist yet — pattern registry / intent-classifier benchmark).

## [Unreleased — staged after 0.1.0-alpha.8] — Code-intelligence doctor surface

The roadmap (`docs/roadmap-code-intelligence.md` §5.5) promised that
each new code-intelligence package would contribute one or more
`shrk doctor` checks. That promise was unimplemented — the doctor
surface ended at the existing inspector checks and never told you
that your code graph was stale, your arch baseline had drifted, or
that a migration checkpoint was still on disk. This round wires
those checks in end-to-end.

### Added — Code-intelligence doctor checks (§5.5)

`runDoctor` now appends a `category: 'code-intelligence'` section
built by `buildCodeIntelligenceChecks(projectRoot)` in
`packages/inspector/src/code-intelligence-doctor.ts`. Each finding
reads a stable on-disk state file under `.sharkcraft/` and stays
silent when the corresponding feature has not been opted into:

| Finding id | Source file | Behaviour |
|---|---|---|
| `code-intelligence-graph` | `.sharkcraft/graph/meta.json` | OK on fresh; advisory `Warning` past `staleThresholdDays` (default 7); structural `Warning` on corrupt JSON; `Info` ("no index yet") when missing. Surfaces `files / nodes / edges` and cycle count when known. |
| `code-intelligence-graph-cycles` | same | Advisory `Warning` when `largestCycleSize ≥ 3` or `cycleCount ≥ 5`. Points at `shrk arch check` for the breakdown. |
| `code-intelligence-rule-graph` | `.sharkcraft/bridge/meta.json` | Same freshness model as graph; silent when no bridge exists (it builds alongside `shrk graph index`). |
| `code-intelligence-rule-coverage` | same | Advisory `Warning` when `filesUncoveredByRules / filesTotal > 50%`; backed by the new `filesTotal`/`filesCoveredByRules`/`filesUncoveredByRules` counters on `IBridgeManifest`. |
| `code-intelligence-api-surface` | `.sharkcraft/api-surface/signatures.json` | OK on fresh; advisory `Warning` past staleness. |
| `code-intelligence-quality-gate` | `.sharkcraft/quality-gates/last.json` | OK on `overall=pass`; `Warning` on `overall=fail` (lists failing gate ids); `Info+advisory` on `warn|skipped|unknown`. |
| `code-intelligence-migrations` | `.sharkcraft/migrations/*.state.json` | Regular `Warning` on any `overall=fail` checkpoint with `shrk migrate resume <id>` fix (or `prune --include-failed` to discard). |
| `code-intelligence-architecture` | `.sharkcraft/architecture/{baseline,last}.json` | `Warning` on new violations since baseline (with first 3 sample ids); `Info` when one of last/baseline is missing; OK on `delta ≤ 0`. |

Design contract: `@shrkcrft/inspector` deliberately does NOT depend on
any of the new code-intelligence packages. Each check reads the
relevant state file directly with locally-redeclared minimal JSON
shapes, so an uninstalled add-on stays silent rather than breaking
doctor.

### Added — `shrk arch baseline <write|show|clear>`

`@shrkcrft/architecture-guard` now persists a compact snapshot of the
last arch run and an explicit baseline so the doctor can answer
"what new arch violations appeared since we accepted this set?".

- `shrk arch check` writes `.sharkcraft/architecture/last.json` after
  every run (`--no-persist` opts out).
- `shrk arch baseline write` runs a check + writes
  `.sharkcraft/architecture/baseline.json` (schema
  `sharkcraft.architecture-snapshot/v1`). Snapshot keeps counts +
  a sorted, stable violation-id list (`<kind>|<file>[:line]|<target>`)
  so deltas are computed without re-running the full check.
- `shrk arch baseline show` — prints baseline + delta vs `last.json`.
- `shrk arch baseline clear` — removes the baseline file.

New public API in `@shrkcrft/architecture-guard`:
`ArchReportStore`, `ARCH_SNAPSHOT_SCHEMA`, `snapshotFromReport`,
`violationId`, `diffSnapshots`.

### Added — Graph cycle counters at index time

`IGraphManifest` now carries `cycleCount`, `largestCycleSize`,
`filesInCycles` (all optional for forward-compat with manifests
written before 2026-05). Both the full indexer and the incremental
updater call the new `summarizeCycles(nodes, edges)` from
`@shrkcrft/graph/query/cycle-detection.ts`, which runs iterative
Tarjan SCC over the `imports-file` subgraph (stack-safe on long
import chains).

`shrk graph index` and `shrk graph status` now report
`cycles: N (largest M)` inline. `shrk graph status --json` adds the
three fields to its payload.

### Added — Bridge rule-coverage counters

`IBridgeManifest` (`sharkcraft.rule-graph/v1`) now carries
`filesTotal`, `filesCoveredByRules`, `filesUncoveredByRules` (all
optional for forward-compat). The bridge builder tracks the set of
file ids with at least one `applies-rule` edge (boundary OR
knowledge-rule sources; `matches-path` / `covered-by-template` are
deliberately excluded — they signal location / generation, not
policy). Doctor surfaces the coverage ratio.

### Roadmap

`docs/roadmap-code-intelligence.md` status table gains a "Doctor
integration" row and §5.5 is rewritten with a per-package table
showing shipped checks vs deferred items.

## [Unreleased / 0.1.0-alpha.8 — staged, not yet published] — Cleaner shrk: honest doctor, polished errors, pack-discovery cache

A focused round of "make shrk genuinely cleaner and more useful
without adding features," in three layers:

  1. **Substantial UX:** honest doctor verdicts + shape-aware
     scoring, polished error / did-you-mean output, README that
     openly links the benchmark.
  2. **Substantial perf:** pack-discovery now caches at process
     level (16× speedup on warm calls).
  3. **Substantial cleanup carried over from prior staging:** ~20-
     command starter surface, R-cycle markers stripped, dashboard
     pruned to 10 "project state" pages.

**Staged but not published.** Run
`bun run scripts/bump-versions.ts 0.1.0-alpha.8 --write` followed by
`bun run publish:packages --tag alpha --yes` when ready to ship.

### Changed — Honest doctor output (replaces fuzzy 0..100 score)

The old `AI-readiness: X / 100 (grade)` was an aggregate that didn't
know what kind of project it was scoring. A library got dinged for
"no pipelines"; a generic CLI got dinged for "no templates"; a repo
with zero installed packs got a neutral 5/10 on pack-discovery
that rewarded inaction. Self-scored 75/100 even when the benchmark
showed shrk was net-negative in real use.

`buildAiReadinessReport()` now classifies each readiness dimension
as one of:

- `core` — counts in the aggregate score, produces a recommendation
  if below threshold.
- `advisory` — shown in output, NOT counted, NO recommendation.
  For dimensions that are nice-to-have but not load-bearing for the
  detected workspace shape (e.g. "templates" on a generic library).
- `n/a-for-shape` — hidden by default, NOT counted, NO recommendation.
  For dimensions that are irrelevant (e.g. "pack discovery" when
  no packs are installed).

Two honest binary verdicts ride alongside the score:

- `Ready for agent reads` — config + knowledge loaded, doctor clean.
- `Ready for agent writes` — all of the above + cli-only safety rule
  + no doctor errors. Lists concrete blockers if false.

The visible output now leads with:

```
Shape: monorepo (score counts 13 of 15 dimensions)
  ✓ Ready for agent reads (context / task lookups)
  ✓ Ready for agent writes (apply / generate)

AI-readiness: 79 / 100 (good, shape-aware)
```

Pass `--show-na` to see what was deliberately skipped:

```
Not counted in score (2 dimensions):
  [advisory] Pipelines: 1 pipelines — a repo can be agent-ready with just rules + path conventions.
  [n/a] Pack discovery health: no packs discovered — does not apply.
```

The "Add at least one feature-dev or safe-generation pipeline"
recommendation no longer fires on libraries.

### Changed — Polished unknown-command / did-you-mean output

Before:

```
Unknown command: doctorz
Did you mean:
  shrk commands doctor — Check catalog completeness …
  shrk doctor — Workspace doctor …
  shrk fix doctor — Fix-system doctor …
```

After:

```
shrk doesn't have a `doctorz` command.
Did you mean `shrk doctor`?
  Workspace doctor: config + entry validation.
Other close matches:
  shrk fix doctor — …
  shrk packs doctor — …
```

The renderer now:

- Re-ranks ties by command length so the canonical short verb beats
  longer descendants on a tie (e.g. `doctor` beats `commands doctor`).
- Uses Levenshtein distance to gate the "confident match" path
  (1-char-off typo like `inspct → inspect` qualifies; description-
  token-overlap noise like `frobnicate → bundle diff` does not).
- Falls back to "Run `shrk help` to see the curated commands" when
  no close match exists, instead of dumping unrelated guesses.

### Added — Pack-discovery caching

`discoverPacks()` is the slowest single step of `inspectSharkcraft()`
(it walks `node_modules/` reading every `package.json`). The function
now caches its result at process level, keyed by `projectRoot` +
lockfile fingerprint (mtime + size of `bun.lockb` / `bun.lock` /
`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`, whichever
exists).

- **Cold call:** 16 ms (unchanged).
- **Warm call (same lockfile):** 1 ms — 16× speedup.
- **Cache invalidation:** automatic on any install / uninstall / upgrade.
- **Bypassed** when `verifySignatures: true` (security-sensitive) or
  `extraRoots` (test setups), or explicitly via `noCache: true`.
- **Public escape hatch:** `clearPackDiscoveryCache()` for tests that
  want a clean slate between runs.

Repeated `inspectSharkcraft()` calls within a single CLI invocation
(common in MCP servers and chained commands like `shrk doctor &&
shrk task`) now skip the node_modules walk on the second+ call.

### Added — Catalog hint: `understand-task` points at `task`

`shrk understand-task "<task>"` now declares `overlapsWith: ['task',
'recommend']` and `preferredCommand: 'shrk task "<task>"'`. Surface
this via `shrk surface explain understand-task` or `shrk commands
docs-check`. No behavioral change to existing scripts.

### Changed — README is honest about the benchmark

The README now has a "Does it actually help an AI agent today?"
section that links the benchmark result directly. The honest
summary: out-of-the-box on a NestJS / Angular / Nx repo, shrk was
net-negative (+31% wall-clock, +18% tokens, identical quality).
The section lists the four configuration steps that move shrk
from net-negative to net-positive (framework-correct preset,
populate paths, write project-specific rules, run `shrk doctor`
before trusting for agent workflows).

The benchmark hasn't been re-run on the alpha.5+ framework-correct
preset families. README invites the result.

### Added — `shrk export claude-commands` (per-project slash commands for Claude Code)

Pairs with the alpha.8 `claude-skill` export to cover the second
half of Claude Code's native primitive set: `.claude/commands/*.md`
slash commands.

```
shrk export claude-commands         # dry-run preview
shrk export claude-commands --write # writes the .md files
```

Produces a small set of stable, project-specific slash commands users
type in Claude Code:

  - `/follow-shrk` — reminder of the apply-gate flow.
  - `/check-changes` — runs the diff-scoped boundary + import-hygiene
    checks (delegates to `shrk diff-check` below).
  - `/shrk-brief` — pulls `shrk brief` for the current project.
  - `/explain-file <path>` — per-file rules / paths / boundaries.
  - `/new-<template>` — one slash per id in `sharkcraft/templates.ts`,
    capped at 20. Runs the full plan → apply → validate flow.

Each file is a self-contained recipe (YAML frontmatter +
markdown body). No `@shrkcrft/*` imports, no shell expansions —
Claude Code reads the file and follows the steps. Companion semantics
to `claude-skill`:

  - **claude-skill** = passive (rules pulled into Claude's prompt by
    description match).
  - **claude-commands** = active (user invokes by typing the slash).

Slash-name collisions (two templates sharing a tail like
`new-service`) fall back to the full id (`new-typescript-service`)
to disambiguate. Sorted by template id for deterministic output.

### Added — `shrk diff-check` (one-call agent self-validation)

The replacement for "remember to run two checks after every edit."
One command, one envelope, one verdict:

```
shrk diff-check          # human output with Next: line
shrk diff-check --json   # structured envelope for agents
```

Composes `shrk check boundaries --changed-only` and `shrk check
imports --changed-only` against the same scope (worktree / staged /
since / files), then collapses into:

```json
{
  "schema": "sharkcraft.diff-check/v1",
  "scope": { "mode": "worktree", "files": [...], "fileCount": 5 },
  "boundaries": { "ran": true, "counts": { "error": 0, ... }, "violations": [...] },
  "imports": { "ran": true, "verdict": "ok", "counts": {...}, "findings": [...] },
  "verdict": "ok" | "warnings" | "errors",
  "summary": "Diff passes the gate (...).",
  "nextAction": "Safe to declare done."
}
```

Exit code reflects verdict (0 for ok/warnings, 1 for errors). The
`nextAction` line is concrete: agents know exactly what to do next
without re-asking the user.

Also exposed as the `get_diff_check_report` MCP tool (read-only).
Added to the primary MCP tools allowlist so it shows up in
`tools/list` by default. Pairs with the `/check-changes` slash
command above — Claude users typing `/check-changes` get the same
gate via a slash, MCP-connected agents get it via the tool.

### Added — `get_file_advice` MCP tool (per-file context for agents)

The MCP-side mirror of `shrk why <file>`. For a given file path,
returns the rules, path conventions, boundary rules, and knowledge
entries that apply to it — single call, no browsing-the-catalog
required.

```
Tool: get_file_advice
Input: { "file": "apps/users/src/profile.service.ts", "limit": 10 }
Output: { schema, target, pathConventions, rules, boundaries, knowledge, suggestedNext }
```

Same engine as the CLI's `shrk why` (the existing `buildWhyReport`)
— no logic duplication. Added to the primary MCP tools allowlist.

We did NOT add a `shrk advise` CLI alias — `shrk why <file>` already
covers the CLI side; a second command would be pure surface bloat.

### Added — `shrk import <format> --populate` (populate sharkcraft/ from existing CLAUDE.md / AGENTS.md / .cursor/rules)

The mirror half of `--infer`. Most teams using AI agents today
already have ONE of: `CLAUDE.md`, `AGENTS.md`, or
`.cursor/rules/*.mdc`. `shrk import` previously parsed those files
into a draft TS file under `sharkcraft/imports/` that the user had
to adopt by hand. The new `--populate` flag does the adoption
automatically.

```bash
# Most teams have one of these already.
shrk import claude-md ./CLAUDE.md --populate --write
shrk import agents-md ./AGENTS.md --populate --write
shrk import cursor-rules ./.cursor/rules/ --populate --write

# Each routes entries by type into the canonical files:
#   sharkcraft/rules.ts        ← KnowledgeType.Rule entries
#   sharkcraft/paths.ts        ← KnowledgeType.Path entries
#   sharkcraft/knowledge.ts    ← Convention / Architecture / Warning / Workflow / etc.
#   sharkcraft/sharkcraft.config.ts (auto-wired to whatever was populated)
#   sharkcraft/.imported-report.md   ← confidence triage
#   sharkcraft/.imported-report.json ← machine-readable
```

**Same honest confidence triage as `--infer`:**

- **Adopted directly** (priority Critical/High + non-trivial body) — written without marker.
- **Adopted with `// TODO: review`** (Medium priority) — written with an inline review comment.
- **Dropped** (Low priority / title-only / Template type) — left out and listed in the report so the user knows what was considered.

**Why Template entries always drop:** markdown describes templates
but doesn't give a runnable scaffold body. Listed in the report,
not pretended to be populated. Users author runnable templates in
`sharkcraft/templates.ts` by hand.

**The adoption story is now complete.** Combined with `--infer`:

- Fresh repo, no existing rule files → `shrk init --infer --write`
- Existing repo with `CLAUDE.md` → `shrk import claude-md ./CLAUDE.md --populate --write`
- Existing repo with `.cursor/rules/` → `shrk import cursor-rules ./.cursor/rules/ --populate --write`

In every case, **adoption cost ≈ 0**: one command, populated repo, honest report.

**Safety identical to `--infer`:**
- Dry-run by default; `--write` to persist.
- Refuses to overwrite without `--force`.
- Bypasses the older `--write` (writes-draft-under-`sharkcraft/imports/`) path.

**Architecture.**
- `packages/importer/src/emit/synthesize-populated.ts` — pure
  function: `IImportedEntry[]` → `{ files, report }`. Type-based
  routing, confidence triage, self-contained output (matches the
  local-mirror preamble pattern).
- `packages/cli/src/commands/import.command.ts` — `runPopulateImport`
  wires the engine into `shrk import --populate`. Composes with
  `--write` / `--force` / `--json` consistently with the existing
  drafts path.
- 16 new tests in `packages/importer/src/__tests__/synthesize-populated.test.ts`
  pin: file-set contract, type routing (Rule → rules.ts etc.),
  confidence tiers (high / medium / low / Template-always-drops),
  determinism, config-doesn't-reference-missing-files, and the
  every-entry-has-type invariant (the bug that surfaced on first
  integration — knowledge validator rejects entries missing `type:`
  even when the file context implies it).

**End-to-end verified** against the engine's own CLAUDE.md:
22 entries parsed, 2 adopted high / 18 marked for review / 2
dropped. Resulting populated repo passes `shrk doctor` with
"Verdict: Ready for AI-agent use ✓" and 0 errors.

### Added — `shrk init --infer` (populate sharkcraft/ from real codebase signals)

The single largest UX improvement in alpha.8 staging. Instead of
writing preset defaults + a `TODO: customize these` advisory, shrk
now scans the repo and emits **populated** `sharkcraft/*.ts` files
from what it actually finds.

```bash
shrk init --infer --write
# Scans the workspace, runs the existing buildOnboardingPlan +
# triages each inferred entry by confidence, then writes:
#   sharkcraft/sharkcraft.config.ts
#   sharkcraft/knowledge.ts          ← agent briefing + safety seed
#   sharkcraft/paths.ts              ← from detected directories
#   sharkcraft/rules.ts              ← from tsconfig + package.json signals
#   sharkcraft/boundaries.ts         ← from layer structure (when detected)
#   sharkcraft/pipelines.ts          ← from package.json scripts
#   sharkcraft/.inferred-report.md   ← what was adopted vs needs review
#   sharkcraft/.inferred-report.json ← machine-readable equivalent
```

**Honest-by-design confidence triage.** Every inferred entry lands
in one of three buckets:

- **Adopted directly** (high confidence) — written without a marker.
- **Adopted with `// TODO: review`** (medium confidence) — written
  with an inline comment so the user reviews + removes the marker.
- **Dropped** (low confidence) — left out of the populated files and
  listed in `.inferred-report.md` so the user knows what was
  considered.

The companion `.inferred-report.md` lists the triage by category, an
explicit "what shrk can't infer" section (project-specific
decisions, deprecated paths, cross-cutting concerns, team workflow
conventions), and points the user at `shrk onboard --write-drafts`
for the dropped-templates case.

**End-to-end verified** against `examples/unconfigured-bun-service`:
- 14 entries adopted directly (4 path conventions + 1 rule + 4
  pipelines + 5 verification commands)
- 1 entry marked for review (medium-confidence rule)
- 3 entries dropped (template candidates — too speculative to
  auto-emit; available as drafts via `shrk onboard`)
- The resulting populated repo passes `shrk doctor` with "Ready for
  agent reads ✓" and a shape-aware AI-readiness score.

**Composes with `--with-claude-skill`.** Run
`shrk init --infer --write --with-claude-skill` to scan + populate
+ inline into Claude's prompt in one command.

**Safety:**
- Dry-run by default; `--write` to persist.
- Refuses to overwrite existing files without `--force`.
- Emits the report file even on re-run with `--force` so the user
  can re-read the triage.
- Bypasses `--preset` entirely — the inferred output IS the
  populated `sharkcraft/`. Mixing inferred + preset defaults would
  muddy the confidence reporting.

**Architecture.**
- `packages/inspector/src/synthesize-from-onboarding.ts` — pure
  function: `IOnboardingPlan` → `{ files, report }`. Reuses the
  existing `buildOnboardingPlan` (already scans tsconfig, package.json,
  file layout, import structure, etc.).
- `packages/cli/src/commands/init.command.ts` — `runInferInit`
  wires the engine into `shrk init --infer`, handles `--dry-run` /
  `--write` / `--force` / `--with-claude-skill` semantics
  consistently with the preset path.
- 7 new tests in
  `packages/inspector/src/__tests__/synthesize-from-onboarding.test.ts`
  pin the file-set contract, self-contained-emit invariant,
  confidence triage shape, determinism, and config-doesn't-reference-
  files-that-don't-exist.

This is the work that closes the "shrk's authoring cost is too
high" gap. A user can now run one command and get a populated repo
that reflects their actual codebase signals — no upfront authoring,
no "fill in the TODOs" scaffolding.

### Added — `shrk init --with-claude-skill` (one-step setup)

A new flag on `shrk init` chains the claude-skill export onto a
successful preset apply, so a fresh user goes from a clean repo to a
working `.claude/skills/<name>/SKILL.md` in one command:

```bash
shrk init --with-claude-skill --write
# scaffolds sharkcraft/ + writes .claude/skills/<project-slug>/SKILL.md
# in a single invocation; init's "Next" block points at brief + the
# canonical generation flow.
```

The flag is also aliased as `--with-skill` for typing convenience.
Skipped silently in `--dry-run`; respects `--force` for overwriting
an existing skill file.

### Changed — `shrk export claude-skill` body is high-signal only

Skills are inlined into Claude's prompt, so every entry costs
context every time the skill loads. The skill body now filters rules
+ path conventions to `priority: critical | high` only, with a
fallback to "all" if the filtered list is empty (no high-priority
entries yet ≠ ship-empty-skill). Caps stay configurable via
`--max-rules` / `--max-paths`. Result: smaller, denser skills with
no padding from medium / low entries.

### Added — Primary MCP tools allowlist

The MCP server now advertises ~32 primary tools by default via
`tools/list` instead of all ~250. Every tool stays callable via
`tools/call` — the allowlist only affects discovery — but the
focused list dramatically improves Claude's tool-selection accuracy
(the strict-review feedback specifically flagged this). Escape
hatch: set `SHRK_MCP_FULL_TOOLS=1` to advertise everything (useful
when debugging tool selection).

Primary tools cover the core agent loops: project orientation,
context routing, registry browsing, safe code generation,
read-only validation, doctor, and search. See
`packages/mcp-server/src/tools/primary-tools.ts` for the exact set.

### Changed — Start screen highlights the one-step path

```
Bootstrap:
  $ shrk init --with-claude-skill --write  — scaffold sharkcraft/ AND inline rules into .claude/skills/ (one-step)
  $ shrk init                              — scaffold sharkcraft/ + config skeleton (without claude-skill)
```

Init's `Next:` block already pointed at `shrk brief` and
`shrk export claude-skill --write` after alpha.8 staging; the new
flag makes the latter a single-command path.

### Changed — README narrowed to honest positioning

The header pitch (`"structured project intelligence"`) was broad
enough to imply shrk fits any repo. The strict review made clear
that's not the right framing — shrk pays off for a specific repo
profile, and trying to sell it as universal undercuts credibility
in the cases where it genuinely shines.

The rewritten top of the README leads with:

1. **A narrow pitch** — "For TypeScript monorepos with architecture
   boundaries that need to outlive any single PR." Names the
   audience directly.
2. **Two specific claims** of what shrk does that native Claude
   Skills + `CLAUDE.md` can't: mechanical boundary enforcement,
   and one-source-of-truth multi-agent emission.
3. **An "Is shrk right for you?" decision tree** — ~5 green-check
   conditions for "yes" and ~4 red-X conditions for "no, use
   Claude Skills directly." A reader self-qualifies in 30 seconds
   instead of installing and discovering it's a bad fit.
4. **A side-by-side comparison table** explicitly framing shrk vs
   native Skills + `CLAUDE.md` (not vs Claude Code itself). The
   right-column items either land for the reader or they don't —
   the doc tells them to "stop here and just use Claude Skills"
   if not.

The existing detailed sections (presets, architecture intelligence,
docs links) are unchanged and stay lower in the document; only the
top-of-fold positioning was rewritten.

### Changed — `shrk brief` compressed from ~100 lines to ~70

Three targeted fixes in `packages/inspector/src/agent-brief.ts`:

1. **Empty sections suppressed.** Sections whose body was just an
   italicized placeholder (`_None._`, `_No impact analysis
   available._`, `_No ownership data._`) used to render anyway,
   taking 3-5 lines each. They're now skipped — the section list
   only includes what actually has content.

2. **Timestamp dropped from the header.** The mode line was
   `_Mode: \`implementation\` — 2026-05-20T...Z_`. A timestamp adds
   noise to a "single page Claude reads first" doc and the
   `IAgentBrief.generatedAt` JSON field still carries it for
   tooling that needs it. Header now just shows the mode.

3. **`[object Object]` bug in action-hints fixed.** The
   `actionHintsSection` was string-interpolating
   `IActionHintCommand` and `IActionHintMcpTool` objects whole,
   producing `- [object Object]` per command/tool. Now reads
   `.command` / `.tool` (+ optional `.purpose`) so each line shows
   the real command and a one-line purpose:

   ```
   - `bun run shrk check boundaries` — Mechanical enforcement of the layer order.
   - `get_relevant_context` — Token-budgeted rules + paths + templates for the task.
   ```

4. **Duplicate `Suggested commands` section dropped from the
   markdown.** The verification commands + action-hint commands
   covered the same set; the dedicated section repeated them. Now
   the section only renders when it would surface a command NOT
   already shown above. The `IAgentBrief.suggestedCommands` JSON
   field is unchanged (tooling contract preserved).

Result against the engine repo: brief output went from 104 lines /
13 sections to 71 lines / 6 sections (-32%). The remaining sections
(project overview, rules, paths, action hints, forbidden, safety)
are all signal — no padding.

### Fixed — Two dev-workflow tests flake under contention

`shrk dev mark-applied → mark-validated` and `shrk dev list` chain
3+ `shrk` subprocesses each. Each bun cold-start is ~1-2s; under
full-suite parallel contention the 5s default budget can squeeze
past. Bumped per-test timeout to 30s on both. Same fix pattern as
the earlier MCP `create_execution_graph` flake.

### Added — `shrk export claude-skill` (the inversion)

Generate `.claude/skills/<project>/SKILL.md` from sharkcraft assets so
the rules land in Claude's prompt **automatically**, with zero MCP
round-trip and zero "remember to read CLAUDE.md" friction. The skill
file carries a tight YAML frontmatter (`name`, `description`) that
Claude Code uses to decide when to load it, plus a decision-driving
body covering path conventions, rules, do/don't, and the safe write
path.

```bash
shrk export claude-skill --write
# → .claude/skills/<project-slug>/SKILL.md, loaded automatically by
#   Claude Code in any session opened against this repo.
```

Beats the MCP round-trip latency problem entirely — the rules are
inlined into the prompt the moment Claude opens the project. Five
formats now in `shrk export`: `claude-skill` (new + recommended),
`agents-md`, `claude-md`, `cursor-rules`, `copilot-instructions`.

### Changed — Start screen + init flow surface the inversion

`shrk help` start screen now leads "Use it for a task" with
`shrk brief` (the canonical first-touch — single-page brief Claude
reads first) and dedicates a "Run shrk for an agent" section to the
two paths: inlined-into-prompt (`shrk export claude-skill --write`)
vs live-query (`shrk mcp serve`).

`shrk init` next-steps now points at `shrk brief` and
`shrk export claude-skill --write` directly, so a fresh user goes
from init → Claude-knows-the-codebase in two commands.

### Changed — Catalog trim to ~27 visible top-level verbs

The `--full-help` view now filters through a new
`PRIMARY_VERBS_ALLOWLIST` of ~30 rent-paying verbs. The catalog still
contains ~360 entries; everything stays callable. Default `--full-help`
shows 27 top-level commands (down from 73) with a clear hint at the
bottom:

```
…and 54 more, hidden from default help. Run `shrk --full-help --all`
to see them, or `shrk surface list` to browse by tier.
```

Power users: `shrk --full-help --all` dumps the full catalog
unchanged. The MCP-tool surface and `shrk surface list` are
unaffected — this is purely a default-help filter.

### Changed — README leads with a one-sentence pitch

Replaced the jargon-y "Structured project intelligence" header
with the concrete promise the strict review demanded: "shrk gives
Claude the boundary rules, path conventions, and review gates your
team already follows — so Claude writes code that matches your
codebase instead of generic patterns."

The README opening now shows the end-to-end loop —
`init → export claude-skill → brief → gen → apply` — in five
shell lines, so a prospective user sees the value flow in 30 seconds.

### Deferred to a later release

- **Re-run the benchmark on alpha.7+/alpha.8.** Requires driving two
  Claude subagents in worktrees over wall-clock time; cannot be done
  from a single AI session. Use `bench/runner-instructions.md` to
  reproduce — the number is the marketing.
- **Trim MCP tool count from 250+ to ~30.** The CLI catalog is now
  filtered through the allowlist, but MCP tool exposure still
  advertises everything. Same allowlist approach should apply on
  the MCP side; deferred to its own release.
- **Two deep, opinionated example repos** (`react-app` and
  `nest-service`) hosted alongside SharkCraft so prospective users
  can clone a working setup. The presets are good; the missing
  piece is "here's a repo that actually uses it."
- **`shrk plan from-message`** — parse a Claude chat reply for a
  proposed change and turn it into a plan that goes through the
  boundary/test gates. High-leverage but needs its own design pass
  (parsing natural language reliably is hard).
- **Output consistency pass across the top 30 commands.** Auditing
  text vs `--json` envelope shapes for 30+ commands would take a
  day on its own; the higher-leverage doctor + error-message +
  inversion + perf work above is what alpha.8 ships. Logged as TODO.
- **Test-file renames (r##-* → descriptive names).** ~150 files. The
  test runner output still shows internal cycle markers. Mechanical
  but spans many files; punted to avoid one giant rename commit
  mid-release.

## [Unreleased / 0.1.0-alpha.7 — superseded — see alpha.8] — Surface trim + R-marker cleanup + dashboard prune

The "strict review" feedback round. Cuts UX noise without breaking
backward compatibility: tightens the visible CLI start screen to ~20
curated commands, strips internal R-cycle development markers from
the public surface, and prunes four dashboard pages that didn't fit
"see project state".

Folded into alpha.8 before shipping — the items below now appear
under the alpha.8 heading.

### Changed — CLI start screen surfaces ~20 curated commands

- **`shrk` / `shrk help`** now shows a 20-command starter surface
  organised into five workflow sections (Bootstrap / Use it for a
  task / Generate code safely / Browse what shrk knows / Run shrk
  for an agent), plus a final "discover the rest" pointer to
  `surface list` and `--full-help`. Previously only 6 commands
  were promoted to "core" with everything else hidden behind a
  generic discovery link.
- **No commands were demoted or removed** — the full ~70-verb
  catalog is still callable and still visible via `shrk --full-help`,
  `shrk surface list`, or `shrk help <command>`. The change is
  purely the curated landing surface a new user sees first.
- `packages/cli/src/__tests__/r42-product-surface.test.ts` and
  `packages/cli/src/__tests__/r56-followup-profiles.test.ts` updated
  to assert the new shape (allow gen / apply on the start screen;
  cap line count at 55 rather than 30).

### Changed — R-cycle markers stripped from user-facing data

The `R##` development-cycle markers (R28, R29, R30, R31, R32, R45,
R47, R56, ...) leaked into the engine's own knowledge entries,
preset exports, and prose. They were meaningful only inside the
SharkCraft team's planning loop and confusing to outside readers.
This release strips them from everywhere they showed up in
published content:

- **`sharkcraft/knowledge.ts`** — 88 occurrences removed. Entry
  titles with R-cycle suffixes (e.g. ` (R32)`) were stripped to the
  base title. Scope and tag arrays with R-cycle markers (`'r28'`,
  `'r32'`) had those entries removed. Prose lines mentioning the
  cycle (e.g. `"is the headline R28 deliverable"`) were rephrased
  to describe the feature directly.
- **`@shrkcrft/presets` internal exports renamed** —
  `R26_PRESETS` → `MULTI_STACK_PRESETS`,
  `R45_PRESETS` → `UNIVERSAL_ADOPTION_PRESETS`,
  `R47_PRESETS` → `CANONICAL_ALIAS_PRESETS`. These were not in the
  public API of `@shrkcrft/presets` (only `BUILTIN_PRESETS` is
  re-exported via the package index), so the rename is purely
  internal. File names `r26-presets.ts` / `r45-presets.ts` /
  `r47-presets.ts` kept as-is — they're internal to the package.

Test files / file names with `r##-` prefixes (158 occurrences)
left in place for this round — they're internal and renaming them
would create churn with no user-visible benefit.

### Changed — Dashboard pruned to ten "project state" pages

Removed four dashboard routes that were tied to advanced workflows
rather than "see the state of this project":

- `/commands` — full command catalog browser
- `/onboarding` — onboarding workflow tracker
- `/reports` — report renderer for advanced report kinds
- `/review-ci` — PR review packet builder

The four backing data endpoints stay live in
`packages/dashboard-api` so CLI consumers and power users can still
hit them via `shrk dashboard export` or direct API. Only the
React routes + sidebar nav items were removed. Dashboard bundle
shrunk from 207 kB → 198 kB.

Kept (10 pages): Overview, Statistics, Architecture, Knowledge
Graph, Quality, Safety, Dev Sessions (+ Session detail), Packs,
Presets & Pipelines, MCP.

### Fixed

- **R-marker stripping had a parse-breaking side effect.** The
  initial sed pass deleted the `// R30 PART 10 — ` prefix on a
  section-divider comment but left the trailing prose (`new
  self-knowledge entries.`) as an orphan line that crashed
  `inspectSharkcraft()` at import time. The crash propagated as
  silent CLI exits and 90+ test timeouts. Fixed by repairing the
  comment + adding `bun -e` smoke-import of `sharkcraft/knowledge.ts`
  to the validation pass.

### Migration notes

No user-facing migration required. Anyone importing the renamed
preset arrays directly (`import { R26_PRESETS } from '@shrkcrft/presets/...'`)
must rename to the new identifiers, but those were not in the
public API of `@shrkcrft/presets` to begin with.

## [0.1.0-alpha.7] — 2026-05-19 — NestJS 11+ and React 19+ preset families

Seventeen new presets and 70+ new rule snippets across two stacks —
the modern NestJS service surface (Nest 11+) and the modern React app
surface (React 19+). Both mirror the alpha.6 Angular 21 family in
shape: focused presets each owning one slice, plus a comprehensive
preset that composes them.

### Added — React 19+ family

- **`@shrkcrft/presets`** — `react19-snippets.ts` and
  `react19-presets.ts`. Rule snippets cover: function components (no
  React.FC, no class components for new code); props as interfaces;
  ref-as-a-prop (no forwardRef in the common case); `<Context>` as the
  provider directly (no `.Provider`); document metadata in the tree;
  scoped stylesheets via `<link precedence>`; self-closing JSX; rules
  of hooks; `useEffect` ONLY for external-system sync (no derived
  state, no event responses, no fetches); `key` prop for state reset
  (not useEffect); custom hook naming + cleanup; the React 19 Actions
  surface (`<form action>`, `useActionState`, `useFormStatus`,
  `useOptimistic`, `use()`); async functions in `startTransition`/
  `useTransition`; server state in TanStack Query / SWR / RTK Query;
  client state shape proportional to scope; React Hook Form + Zod for
  non-trivial forms; the React Compiler obsoleting most hand-rolled
  `useMemo`/`useCallback`; code-splitting via `React.lazy` + Suspense;
  list virtualization past ~100 visible rows; stable list keys;
  explicit image dimensions + `loading="lazy"`; `useTransition`/
  `useDeferredValue`/Suspense boundaries; StrictMode in dev; Vitest +
  Testing Library + `userEvent` + MSW; React Server Components
  default with `"use client"` pushed to interactive leaves, Server
  Actions for mutations, streaming SSR through Suspense.

- **Nine new presets** (weight 11-12, beats the legacy `frontend-app`
  at weight 6 in the recommender):
  - `react-19-modern-components` — function components, ref-as-prop,
    Context-as-provider, document metadata in the tree.
  - `react-19-hooks-discipline` — rules of hooks, useEffect for
    external sync only, key-for-reset, custom-hook naming + cleanup.
  - `react-19-actions-forms` — Actions, useActionState, useFormStatus,
    useOptimistic, use(), async transitions.
  - `react-19-state` — TanStack Query for server state, the right
    shape for client state, RHF + Zod for forms, no prop-drilling.
  - `react-19-performance` — React Compiler, lazy + Suspense,
    virtualization, stable keys, image optimization.
  - `react-19-concurrent` — useTransition, useDeferredValue,
    deliberate Suspense placement, StrictMode in dev.
  - `react-19-testing` — Vitest + Testing Library + userEvent + MSW,
    behavior-not-implementation testing posture.
  - `react-19-rsc` — Server Components default, `"use client"` at the
    leaf, Server Actions, streaming SSR. Intentionally NOT pulled in
    by `react-19-modern` since it only applies to RSC frameworks
    (Next.js app router, Remix, Waku).
  - `react-19-modern` — comprehensive; composes the seven non-RSC
    focused presets. Add `react-19-rsc` separately for fullstack apps.

- **Path snippets** — `REACT_PATH_COMPONENTS`, `REACT_PATH_HOOKS`,
  `REACT_PATH_PAGES`, `REACT_PATH_LIB` in `shared-snippets.ts`, each
  with structured `metadata.path` so the init paths-advisory annotator
  catches mismatches (e.g. a Next.js app-router project that uses
  `app/` instead of `src/pages/`).

- **Tests** — `packages/presets/src/__tests__/react19-presets.test.ts`
  asserts: all nine presets are registered; `react-19-modern`
  composes the seven non-RSC focused presets and intentionally does
  NOT compose `react-19-rsc`; each focused preset includes its
  canonical rule (e.g. `useActionState` in actions, `Vitest` + `MSW`
  in testing, `"use client"` + `"use server"` in RSC); every emitted
  .ts is self-contained; the recommender picks a `react-19-*` preset
  for a React frontend workspace.

### Added — NestJS 11+ family

### Added — NestJS 11+ family content

- **`@shrkcrft/presets`** — `nest11-snippets.ts` and `nest11-presets.ts`.
  Rule snippets cover: thin controllers / service-owns-domain /
  module-per-feature / module public-API / no-circular-modules /
  DTOs-at-boundary / no-query-in-controller; global ValidationPipe
  with whitelist + forbidNonWhitelisted + transform; class-validator
  DTOs as classes (not interfaces); separated request / response DTOs;
  `@ApiProperty` for OpenAPI; lifecycle hooks (OnModuleInit /
  OnApplicationBootstrap / OnModuleDestroy / OnApplicationShutdown);
  `enableShutdownHooks()` at bootstrap; async `useFactory` providers;
  Fastify adapter; `@nestjs/cache-manager`; `@nestjs/throttler`;
  mandatory pagination on list endpoints; helmet; explicit CORS
  allowlist (no `origin: true` in prod); JWT auth via Guards (not
  middleware); no-secrets-in-source; trust-proxy when behind a load
  balancer; per-provider `Logger(MyService.name)`; structured JSON
  logs (pino / nest-winston); no-log-secrets redaction; `@nestjs/terminus`
  health checks with split liveness + readiness; `Test.createTestingModule`
  + `overrideProvider`; e2e via supertest against the real AppModule;
  unit specs co-located vs e2e under `test/`; URI API versioning when
  the contract is external.

- **Eight new presets** (weight 11-12, beats the existing
  `nestjs-service` at weight 7 and `nest-service` canonical alias at
  weight 9 in the recommender):
  - `nest-11-architecture` — module + controller + service +
    repository structure, DTOs at the HTTP boundary.
  - `nest-11-validation` — global ValidationPipe strict-mode +
    class-validator DTOs + separated request / response shapes.
  - `nest-11-async-lifecycle` — async providers + lifecycle hooks +
    `enableShutdownHooks()`.
  - `nest-11-performance` — Fastify adapter + caching + throttling +
    mandatory pagination.
  - `nest-11-security` — helmet + CORS allowlist + JWT guards +
    no-secrets + trust-proxy + throttler.
  - `nest-11-observability` — per-provider Logger + structured JSON
    logs + redact-list + terminus health (liveness + readiness).
  - `nest-11-testing` — TestingModule + overrideProvider unit specs
    + supertest e2e + co-located vs `test/` file layout.
  - `nest-11-modern` — composes all seven, layers on URI API
    versioning.

- **Tests** — `packages/presets/src/__tests__/nest11-presets.test.ts`
  asserts: all eight presets are registered; each canonical rule is
  present in its area (e.g. `enableShutdownHooks` in async-lifecycle,
  `helmet` + `JwtAuthGuard` + `trust-proxy` in security, `terminus`
  + `liveness` + `readiness` in observability); every emitted .ts is
  self-contained; `recommendPresets` picks a `nest-11-*` preset for a
  NestJS+backend+service workspace.

### Changed

- **Auto-pick tests updated for both stacks** —
  `r47-adoption-top5.test.ts` now expects the new canonical winners:
  `nest-11-modern` (weight 12) supersedes `nest-service` (weight 9)
  for NestJS workspaces; `react-19-modern` (weight 12) supersedes
  `react-app` (weight 6) for React workspaces. The legacy ids stay in
  the catalog and remain reachable via explicit
  `--preset nest-service` / `--preset react-app` for projects that
  pin them.
- **One MCP test got a longer timeout** — `create_execution_graph
  returns nodes and edges` calls `inspectSharkcraft()` which walks
  the whole engine repo and the catalog is bigger now (3 new preset
  families). Bumped the per-test timeout to 30s so the test doesn't
  flake under full-suite contention.

### Removed

- **Unscoped `shrk` wrapper package.** The repo previously shipped a
  `packages/shrk/` thin forwarder so users could type
  `npx shrk@alpha init` instead of `npx @shrkcrft/cli@alpha init`. The
  unscoped name was blocked by npm's anti-typosquatting check on
  first publish (too similar to `shx`, `sharp`, `swr`, etc.) and the
  wrapper added no functional surface — `@shrkcrft/cli` already
  declares `bin: { shrk: "./dist/main.js" }`, so once the scoped
  package is installed, the `shrk` binary is on PATH from it directly.
  Canonical install commands are now:
  ```bash
  npx @shrkcrft/cli@alpha init     # one-shot
  npm install @shrkcrft/cli@alpha  # then `shrk` on PATH (or via npx --no-install shrk)
  ```
  The 22 scoped packages are unchanged and contain all the
  functionality. README + docs updated accordingly.

### Why

Same logic as alpha.6's Angular 21 family. The legacy presets predate
the patterns most teams now treat as table stakes — for Nest:
Fastify, strict ValidationPipe, terminus health, explicit CORS
allowlist, structured logging, throttler defaults. For React:
function components only, hooks discipline (useEffect for external
sync only), Actions/useActionState, server state in TanStack Query,
React Compiler auto-memo, Vitest + Testing Library. Rather than
rewrite the legacy presets in-place and break consumers who pinned,
the alpha.7 set ships alongside as a higher-weighted family.

### Added — Distribution + UX (agent feedback follow-up)

A downstream Claude agent flagged three friction points using `shrk` in
a host repo. All three are addressed in this slice.

- **`npx shrk@alpha` resolves on the public registry.** New unscoped
  wrapper package at `packages/shrk/` — its sole job is to depend on
  `@shrkcrft/cli` and forward to `runCli()`. Same surface, same flags,
  same exit codes. The published `bin` is `dist/bin.js` (named
  `bin.js`, not `main.js`, so the CLI's own entry-point guard does not
  double-fire when both modules load). Source: `packages/shrk/src/bin.ts`,
  `packages/shrk/src/index.ts`, `packages/shrk/package.json`. Existing
  scripts (`publish-packages`, `install-smoke-test`, `release-preflight`)
  pick up the new package automatically via `discoverPackages`.

- **Doctor headline no longer drowns in `actionhints-*` warnings.**
  `runDoctor` in `packages/inspector/src/sharkcraft-inspector.ts` now
  flags every action-hint quality check with `advisory: true`. The
  existing fold pipeline (`foldDoctorChecks` in
  `packages/cli/src/doctor/doctor-tags.ts`) already knew how to
  collapse advisory warnings into a one-line summary —
  `Folded: N advisory (run with --show-advisory or --strict to expand)`.
  `--strict=warnings` continues to exclude hint-quality (existing
  contract); `--strict=all` continues to count them; JSON output is
  unchanged. A real downstream repo with 367 of these now shows a
  single summary line by default. Test:
  `packages/inspector/src/__tests__/actionhints-advisory.test.ts`.

- **`shrk check boundaries --watch` for inner-loop iteration.** The
  watch helper at `packages/cli/src/output/watch-loop.ts` gained a
  `defaultPaths` option and a `--paths a,b,c` flag pass-through, so
  callers that scan source outside `sharkcraft/` can watch the right
  trees. `checkBoundaries` in
  `packages/cli/src/commands/check.command.ts` now wraps its single-
  shot path through `maybeRunInWatchMode`, defaulting the watched set
  to `sharkcraft / packages / apps / libs / src / tools`. Flags:
  `--watch [--paths <list>] [--debounce N] [--once]`. Test added in
  `packages/inspector/src/__tests__/r31-feature-accelerator.test.ts`.

### Why — agent feedback follow-up

The three issues all came from the same source: a downstream Claude
agent reporting that `shrk` earns its keep for boundary enforcement
and the AI workflow, but the install story (`npx shrk` 404) and the
inner loop (doctor nag, no boundary watch) made onboarding rougher
than it should be. The fixes are intentionally small and surgical —
no new abstractions, no rewrites — because the engine itself is fine;
only the surface in front of it needed sharpening.

### Fixed — Dist-under-Node TypeScript loading (`npx shrk` parity)

A second round of feedback surfaced the *deeper* part of the same
distribution issue: `npx shrk` resolved, but it couldn't actually
read user `sharkcraft/*.ts` files because Node's `import()` doesn't
speak TypeScript. The CLI silently degraded to "no boundary rules
configured" and "AI-readiness 18/100" against a fully configured
host repo, while `bunx shrk` worked normally. This made the npm
path effectively cosmetic.

- **New `importModuleViaLoader` helper in `@shrkcrft/core`.** When
  running under Node (not Bun) and the target file ends in
  `.ts`/`.tsx`/`.mts`/`.cts`, the helper routes the import through
  [jiti](https://github.com/unjs/jiti) (a tiny TS-aware loader, oxc-
  backed in v2). Under Bun, native `import()` is used unchanged — no
  added latency for the dev path. The jiti instance is lazy-loaded
  and cached.
- **jiti added as a dependency of `@shrkcrft/core`** (`^2.7.0`). It
  is the only addition; every other engine package gets it
  transitively. Library consumers who only import types or pure
  utilities still pay nothing at runtime — jiti loads only when a
  TypeScript file is dynamically imported.
- **23 raw `import(pathToFileURL(file).href)` call sites migrated**
  to `importModuleViaLoader` across `@shrkcrft/config` (config
  loader), `@shrkcrft/inspector` (every registry / loader that
  consumes user-authored TS), and `@shrkcrft/cli/commands/packs*`.
  The migration was scripted (`scripts/migrate-loader-imports.ts`)
  so the diff is mechanical and idempotent.
- **`shrk` wrapper now pins `@shrkcrft/cli` exactly at publish.**
  New `publishPinExact: ["@shrkcrft/cli"]` metadata in
  `packages/shrk/package.json`; `buildPublishPkg` in
  `scripts/lib/publish-mode.ts` honors it by emitting the version
  without a caret. Prevents the wrapper and the CLI drifting across
  releases (a version skew there silently breaks the contract).
- **Flake fix.** `r23-mcp-tools > create_agent_contract` got a 30s
  timeout to match its sibling — same suite-contention story as
  `create_execution_graph`.

End-to-end verification: `node packages/cli/dist/main.js check
boundaries` now returns `2 rules · 1491 files · 5318 imports · 0
violations` (identical to `bun packages/cli/src/main.ts check
boundaries`), and `doctor` reports 75/100 (not 18/100). Test:
`scripts/__tests__/publish-mode.test.ts` adds a case for the
`publishPinExact` transform.

### Hardened — release gate and strict-mode generality

Three small follow-ups to lock in the stability gains and remove the
last bit of accidental coupling in the advisory-warning treatment.

- **`install-smoke-test` now exercises the TS loader end-to-end.**
  Post-init, the smoke test parses doctor output and asserts:
  knowledge entries > 0 AND AI-readiness ≥ 50. It then writes a
  sentinel `sharkcraft/boundaries.ts` rule, points the config at it,
  and runs `npx shrk check boundaries` — failing if rule count < 1.
  The previous test passed even when the Node-side TS loader was
  fully broken (the "Verdict:" line printed regardless). This closes
  the blind spot at release time. `scripts/install-smoke-test.ts`.

- **`doctor --strict=warnings` now keys off `check.advisory === true`,
  not `id.startsWith('actionhints-')`.** Future advisory categories
  (template quality, rule quality, anything else flagged advisory)
  are automatically respected by strict mode without a code edit. The
  string-prefix special case was a quiet correctness trap. Same flag
  surface, more general semantics. `packages/cli/src/commands/doctor.command.ts:91-125`.

- **Removed the one-shot `scripts/migrate-loader-imports.ts`.** Its
  job (migrating 23 raw `import(pathToFileURL(...))` sites to the
  jiti-aware helper) is done. Leaving it in the repo would have
  confused the next contributor into wondering if they needed to
  update it.

## [0.1.0-alpha.6] — 2026-05-18 — Angular 21 preset family

Six new presets and 24 new rule snippets covering the post-decorators
era of Angular (18 / 19 / 20 / 21). Signal-based queries, signal-based
I/O, zoneless change detection, the new template control flow, the
resource() / httpResource() async APIs, and the inject()-based modern
DI surface.

### Added

- **`@shrkcrft/presets`** — `angular21-snippets.ts` and
  `angular21-presets.ts`. Rule snippets cover: signal state /
  computed / effect / linkedSignal; signal-based `viewChild()` /
  `viewChildren()` / `contentChild()` / `contentChildren()`;
  signal inputs (`input()` / `input.required()`); `output()` and
  `model()`; `provideZonelessChangeDetection()` and the
  no-NgZone-APIs posture; the new control flow (`@if` / `@for` /
  `@switch` / `@defer` / `@let`); self-closing tags;
  `NgOptimizedImage`; `inject()` over constructor DI;
  `afterRender` / `afterNextRender`; `providedIn: 'root'`;
  no-NgModules / `bootstrapApplication` + `provideX()` style;
  `resource()` / `httpResource()`; hybrid rendering;
  `provideHttpClient(withFetch())`; signal-forms interop via
  `toSignal()`; signal-input setting in tests via
  `fixture.componentRef.setInput()`.
- **Six new presets** (weight 11-12, beats the older `modern-angular`
  at weight 9 when the workspace declares HasAngular):
  - `angular-21-signals` — local state + queries + inputs + outputs +
    `model()` two-way binding.
  - `angular-21-zoneless` — zoneless CD bootstrap + the
    no-NgZone-APIs posture + `afterRender` lifecycle.
  - `angular-21-control-flow` — `@if` / `@for` / `@switch` / `@defer`
    / `@let`, self-closing tags, `NgOptimizedImage`.
  - `angular-21-resource` — `resource()` and `httpResource()` as the
    canonical async primitives, `linkedSignal` for writable derived
    state.
  - `angular-21-modern-di` — `inject()` function, `providedIn root`,
    no new NgModules, `bootstrapApplication()` + `provideX()` family.
  - `angular-21-modern` — the comprehensive preset that composes all
    five focused ones. Also pulls in hybrid-rendering and the test
    rules for signal inputs and zoneless CD.
- **Tests** — `packages/presets/src/__tests__/angular21-presets.test.ts`
  asserts: all six presets are registered; the canonical rule for each
  area is present (e.g. `viewChild` mentioned in the signals preset,
  `provideZonelessChangeDetection` in the zoneless preset); every
  emitted .ts is self-contained; `recommendPresets` picks an
  `angular-21-*` preset when the workspace is Angular.

### Why

The existing `modern-angular` family (alpha.5 and earlier) was written
when Angular 16/17 was current and predates the signal-query /
signal-I/O / zoneless / resource API surface. Rather than rewrite it
in-place and break consumers who pinned to it, the alpha.6 set lives
alongside as a separate, higher-weighted family. New projects get the
Angular 21 stack by default; projects pinned to `modern-angular` keep
their existing behaviour.

### Migration notes

Same as alpha.4 / alpha.5 — no automatic migration. To pick up the new
presets in an existing repo:

```bash
shrk init --preset angular-21-modern --dry-run  # preview
shrk init --preset angular-21-modern --write    # commit if happy
```

For projects already on a preset preset and willing to switch, the
generated `sharkcraft/*.ts` files are mergeable — the local-mirror
preamble means the new and old files have the same exported shape, so
hand-merging rule arrays works.

## [0.1.0-alpha.5] — 2026-05-18 — Framework-correct paths for Nx, Angular, Nest, polyglot

Follow-up to alpha.4 that fixes the second half of the benchmark finding:
the Nx / Angular / Nest / polyglot presets now ship path conventions that
actually match their target frameworks, so `shrk init --preset nx-monorepo`
in a real Nx repo no longer emits a `paths.ts` advisory listing
`src/services/` as missing.

### Added

- **Framework-specific path snippets** in `@shrkcrft/presets` —
  `NX_PATH_LIBS` / `NX_PATH_APPS` (Nx); `ANGULAR_PATH_APP` /
  `ANGULAR_PATH_COMPONENTS` / `ANGULAR_PATH_SERVICES` (single-app
  Angular); `NEST_PATH_SRC` / `NEST_PATH_E2E` (NestJS, including the
  `test/` directory used by Nest e2e suites); `WORKSPACE_PATH_PACKAGES`
  / `WORKSPACE_PATH_APPS` (Turborepo, npm/pnpm/yarn workspaces);
  `JAVA_MAVEN_PATH_MAIN` / `JAVA_MAVEN_PATH_TESTS`; `PYTHON_PATH_SRC` /
  `PYTHON_PATH_TESTS`; `GO_PATH_CMD` / `GO_PATH_PKG` / `GO_PATH_INTERNAL`;
  `RUST_PATH_SRC` / `RUST_PATH_TESTS`. Each snippet carries a structured
  `metadata.path` field so the init paths-advisory annotator can verify it
  against the live workspace.

### Changed

- **Presets now use framework-correct paths.** The presets that previously
  emitted the generic `src/services/` / `src/utils/` / `tests/` triple
  even when they targeted a specific framework have been switched to the
  new snippets:
  - `nx-monorepo` → `libs/`, `apps/`
  - `angular-app` (built-in and R47 canonical), `modern-angular` →
    `src/app/`, `src/app/components/`, `src/app/services/`
  - `nest-service` (R47), `nestjs-service` (R26) → `src/`, `test/`
  - `turborepo`, `package-workspace` → `packages/`, `apps/`
  - `java-maven-service`, `java-gradle-service` → `src/main/java/`,
    `src/test/java/`
  - `python-service` → `src/`, `tests/`
  - `go-module` → `cmd/`, `pkg/`, `internal/`
  - `rust-crate` → `src/`, `tests/`

### Migration notes

Same as alpha.4 (below). No code-side migration required.

## [0.1.0-alpha.4] — 2026-05-18 — Self-contained init scaffolding

Fixes the root cause behind the alpha.1–alpha.3 benchmark finding that
`shrk` was net-negative in a freshly-init'd downstream repo: every
generated `sharkcraft/*.ts` file used to import from `@shrkcrft/*`
packages, but those packages weren't published yet, so every loader
failed and the project-intelligence layer was offline.

### Fixed

- **No `@shrkcrft/*` imports in any generated scaffolding.** Every
  emitter — `INIT_FILES` (legacy seed), `synthesizePresetFiles()`
  (modern preset path), `emitKnowledgeTs()` (importer),
  `renderConstructDraftsModule()` / `renderRulesDraft()` /
  `renderPathsDraft()` / `renderBoundariesDraft()` /
  `renderConstructsDraft()` (inspector), `rule-scaffold.ts`,
  `construct-adoption-diff.ts` — now produces self-contained TypeScript
  that declares its own minimal helpers (`function defineKnowledgeEntry<T>(e: T): T { return e; }`)
  and enum-like constants inline. The knowledge / templates / pipelines
  loaders are shape-agnostic, so the structured fields still work
  exactly the same way without the import.
- **Surface-config writer no longer falls back to a broken
  `defineSharkCraftConfig` block.** `applySurfaceTextEdit` now handles
  three config patterns — `defineSharkCraftConfig({...})`, `const config = {...}; export default config`,
  and `export default {...}` — so injecting a `surface:` block into the
  new plain config no longer appends a stray import.
- **`sharkcraft.config.ts` is now a plain `export default {...}`.** The
  config loader validates by shape via zod, so the helper call was never
  required.

### Added

- **`packages/cli/src/init/paths-advisory.ts`** — after writing
  `sharkcraft/paths.ts`, init scans every `path: '<x>'` and
  `metadata.path: '<x>'` reference and classifies each `<x>` against the
  live workspace. If any are missing on disk, a clearly-labeled
  `⚠️ Workspace-shape advisory` comment block is prepended to the file
  listing the absent paths, and a `Paths advisory` block is printed to
  stdout. Idempotent and non-destructive — the original entries stay so
  the user can edit them in place.
- **Regression test:** `init-self-contained-emit.test.ts` asserts
  no `@shrkcrft/*` / `@sharkcraft/*` `from '...'` lines in any output of
  the legacy seed, every built-in preset, `emitKnowledgeTs`, and a real
  `shrk init --write` against a tmp project root.

### Build / CI

- **`scripts/build-dist.ts` now also builds the dashboard via Vite** so
  `publish:dry-run` finds `packages/dashboard/dist/index.html` on CI.
- **`scripts/audit-doctor-json.ts` invokes the CLI via
  `bun run packages/cli/src/main.ts`** instead of a globally-installed
  `shrk` binary, so the audit runs on CI even before `build:dist`.
- **`safe-import.test.ts` no longer depends on a Bun deadlock bug**
  that was fixed in newer Bun. The hang scenario uses a top-level
  `await new Promise(() => {})` to construct a deterministic
  never-resolves dynamic import.

### Migration notes — existing user repos

Anyone whose `sharkcraft/` folder was generated by `shrk init` /
`shrk presets apply` on alpha.1–alpha.3 still has `import { ... } from
'@shrkcrft/*'` lines at the top of every `*.ts` file in that folder. The
SharkCraft engine itself runs against shape, not imports, so older
projects keep working — but only because the loader's `safeImport` step
catches the failed resolution and skips silently. To restore full
knowledge / rules / paths / templates loading:

```bash
# pick one:
# (a) regenerate (overwrites local sharkcraft/*.ts — back up first):
shrk init --legacy --write --force

# (b) hand-edit each sharkcraft/*.ts:
#     remove the `import { ... } from '@shrkcrft/...'` lines and replace
#     `defineKnowledgeEntry(x)` / `defineRule(x)` etc. with the inline
#     stub `function defineKnowledgeEntry<T>(e: T): T { return e; }`.
#     The repository's own sharkcraft/*.ts files demonstrate the pattern.
```

The `shrk doctor` advisory output now flags surface-profile drift; if
your project's `sharkcraft.config.ts` carries an outdated
`surface.profile` value, doctor will print which profile it would pick
today.

## [Unreleased] — Cleanup: remove project-specific references and cycle markers

The engine and its assets were carrying project-specific knowledge and
internal development markers that leaked into source, docs, tests, and the
public surface. This round makes the repo project-agnostic by construction
— no SharkCraft asset, test, or doc mentions a particular consumer project
— and strips the `R##` development-cycle markers that are meaningful only
inside SharkCraft's own planning loop. The visible behavior of every
command is unchanged; the surface is just honest about what it is.

### Removed

- **Root cruft** — planning/feedback markdown files at the repo root and
  the `development/` directory (working-notes only; not part of the
  shipping product). These were never published, never referenced from
  `docs/`, and only added noise to clones.
- **Engine purity tests** that hardcoded a project-specific token
  allowlist. Their guardrail role is superseded by the fact that the
  engine is now project-agnostic by construction — the assertion they
  made ("no project-specific strings in engine code") becomes vacuous
  after this cleanup, so keeping them would be testing the test rather
  than the engine.
- **Three consumer-gated integration tests** —
  `knowledge-graph-path.test.ts`, `task-ranker.test.ts`,
  `test-runner-diagnostics.test.ts`. Each skipped at runtime for external
  consumers (they only ran when a sibling consumer repo was resolvable on
  disk), so they contributed zero coverage to anyone outside Anthropic's
  working copy. Equivalent behaviour is exercised by the existing
  `examples/dogfood-target` and `examples/unconfigured-*` fixtures.

### Changed

- **Project-specific text stripped from source, tests, docs, and README.**
  Every prose mention of a particular consumer project / sample task
  descriptions referring to consumer-specific features was rewritten to
  be either project-agnostic ("an consumer pack", "your repository") or
  removed if it added nothing for an external reader.
- **`R##` cycle markers stripped from JSDoc, inline comments, asset
  descriptions, and test names.** The `R12 adds …` / `R14 introduces …`
  prefixes were SharkCraft's internal planning shorthand and meant
  nothing to a first-time reader. Behaviour is preserved; provenance is
  still recoverable from `git log` and the CHANGELOG's existing
  per-round entries.
- **Test fixture naming aligned** in documentation copy and test
  fixtures with the engine's own canonical conventions.
- **`packages/inspector/.../feedback-actions-v2.ts` origin regex
  generalized** — dropped the project-specific alternative from the
  trusted-origin filter so a pack's origin must match the engine's
  published-origin policy rather than a hardcoded consumer prefix.

### Added

- **`.gitignore` rules** for `.nx/`, `.sharkcraft/`, `quality.html`, and
  `.tmp-*` — local-only outputs from `bun nx` / `shrk quality` / smoke
  scripts that were occasionally leaking into clean clones.

### Safety contracts (unchanged)

- No MCP write tools added or removed.
- No CLI verb removed (this is a copy / fixture / dotfile pass, not a
  surface change).
- All 1746 tests pass on this commit.
- Plan-signing, pack-signing, and apply guarantees are unaffected — the
  rename in `feedback-actions-v2.ts` makes the origin allowlist *more*
  conservative, not less.

### Added

- **`shrk grounding "<task>" [--json]`** — single-call context primer
  for plugin / skill consumption. Returns task-relevant rules,
  knowledge, paths, templates, and trusted verification command IDs
  as `sharkcraft.grounding/v1`. Read-only; composes
  `buildTaskPacket` + `searchKnowledge`; no LLM, no shell.
- **`shrk plan check <path>`** — validate ANY external plan/spec
  file against the live workspace. Two built-in extractors
  (`sharkcraft.spec/v1`, `markdown-frontmatter-loose`) and an
  optional `--field-map` for team-specific key remapping. The input
  file is NEVER modified. Returns `sharkcraft.plan-check/v1`.
- **`IPlanExtractor` interface + `IExtractedPlan` shape** in
  `@shrkcrft/generator/grounding`. Internal contract; not exposed
  as a pack plugin-api in R58 (no current consumers).
- **`validateExtractedPlan`** in `@shrkcrft/inspector/grounding` —
  the shared cross-registry validator now used by both R57
  `spec review` and R58 `plan check`. R57's `buildSpecReview` /
  `validateSpecAgainstWorkspace` are thin shims over this pipeline.
- **`loadNxProjects` / `mapFilesToProjects`** — pure-fs Nx project
  graph reader (no shell-out to `nx` CLI). Powers `plan check`'s
  cross-project warning when `nx.json` is present; degrades cleanly
  when absent.
- **`mcp__sharkcraft__get_grounding`** — read-only MCP sibling of
  `shrk grounding`.
- **`mcp__sharkcraft__check_external_plan`** — read-only MCP sibling
  of `shrk plan check`. Accepts either a `path` or inline `content`.
- **Additive-contract test** (`r58-additive-contract.test.ts`) —
  asserts every tracked file outside `.sharkcraft/` is byte-identical
  before / after running the full R58 surface. Mechanically enforces
  the additive principle.

### Changed

- **`packages/inspector/src/spec/spec-cross-validate.ts`** — R57
  `validateSpecAgainstWorkspace` is now a 30-line shim that projects
  the `ISpecJson` onto `IExtractedPlan` and delegates to
  `validateExtractedPlan`. No wire-shape change; R57 tests stay
  green.

### What R58 explicitly cut from the original plan

Documented in `.sharkcraft/reports/r58-additive-audit.md`. Trimmed
items: `--format skill` text envelope, `propose_grounding` MCP tool,
`markdown-heuristic` regex extractor, pack-contributable extractors,
`shrk doc index --extra-paths` (deferred to R59), `externalSpecs[]`
config block (R59), `shrk boundaries infer --from-nx-tags`, the R50
per-round-budget catalog refactor, and Nx integration in
`shrk grounding`. All cuts are justifiable: no current consumer
needed any of them, and shipping speculative surface is exactly the
"bullshit" R58 was supposed to avoid.

### Safety contracts (unchanged)

- MCP never writes. Two NEW read-only tools, zero new write tools.
- The R57 spec surface keeps working with no wire-shape change.
- `shrk grounding` and `shrk plan check` write nothing — the
  additive-contract test mechanically enforces this every CI run.
- No project-specific logic. Consumer packs do NOT need re-signing.

## [Unreleased] — R57: `shrk spec` — intent artifact over plan/review/apply

R57 ships the SDD (spec-driven development) thread from `planning2.md`
as a thin layer over the existing plan/review/apply pipeline. Same
engine, same safety contract, no AI in the engine, no new asset kinds.

### Added

- **`shrk spec <create|review|implement|verify|list|show|status|lint>`** —
  one new top-level verb with eight subcommands. Preview-first
  everywhere; `--write` / `--apply` are opt-in.
- **`sharkcraft.spec/v1`** — frontmatter schema for the spec artifact.
  Lives at `.sharkcraft/specs/<id>/spec.md`. The frontmatter is
  authoritative; the markdown body is inert documentation, capped at
  16 KiB by default.
- **`sharkcraft.spec-review/v1`** — read-only validation report shape.
  Structural validation lives in `@shrkcrft/generator`;
  cross-registry resolution (rule / knowledge / path / template /
  verification command id checks) lives in `@shrkcrft/inspector`.
- **`sharkcraft.spec-implement/v1`** — combined-plan envelope. The
  combined plan is signed by `signPlan` with a note of
  `spec=<id>; frontmatter=<hash>` so the signature is unique to the
  spec AND its content version.
- **`sharkcraft.spec-verification/v1`** — verify report shape.
  `spec verify` runs ONLY trusted verification commands from
  `sharkcraft.config.ts verificationCommands[]` (matching the R44
  hard rule). Includes diff-aware scope-drift detection and plan
  signature integrity check.
- **`sharkcraft.spec-list/v1`** — `spec list` output.
- **`sharkcraft.spec-events/v1`** — per-spec append-only event log at
  `.sharkcraft/specs/<id>/events.jsonl`.
- **Provenance `relatedSpec` back-pointer** — `IAssetProvenanceEntry`
  gains an optional `relatedSpec` field. Schema bumps to
  `sharkcraft.asset-provenance/v2` IFF the field is populated; v1
  entries remain readable forever (back-compat preserved).
- **Four read-only MCP tools** — `list_specs`, `get_spec`,
  `get_spec_review`, `get_spec_verification`. NO write tools.
- **`shrk task --next` ranker insertion** — surfaces "verify spec X"
  as the highest-leverage action when a spec is `implementing`
  without a passing verification (between doctor blockers and
  stale-knowledge fixes).
- **`engine.feature-dev` pipeline** — gains optional `spec-create`
  prelude and `spec-verify` postlude steps (both `enabledWhen:
  'spec'`).

### Changed

- **`shrk start-here`** — PRIMARY_COMMANDS gains
  `shrk spec create` for discoverability.

### Safety contracts (unchanged)

- MCP never writes (no new write tools).
- No fake signing — `signPlan` / `verifyPlan` reused verbatim.
- `spec verify` runs only `trusted: true` verification commands.
- The engine never calls an LLM. Specs are written by humans /
  agents; the engine validates / grounds / executes them.

## [Unreleased] — R56: adaptive surface, project shape, diff-aware checks

R56 changes the underlying assumption: the visible surface is a
function of the project, not of the engine. A single-app repo sees
~10 commands; a 50-library monorepo sees the spine plus everything
its packs contribute. Same engine, different lens.

### Added

- **Surface tiers (`core` / `extended` / `experimental`)** —
  mechanically derived from a hardcoded bootstrap set + the spine
  pipelines + pack contributions + catalog overrides. Documented in
  `docs/surface-tiers.md`.
- **`shrk surface` verb** — `list`, `enable`, `disable`, `hide`,
  `unhide`, `reset`, `explain`. Preview-first; `--write` mutates
  `sharkcraft.config.ts surface{}`.
- **Structured "not enabled" error** — exit code 78, schema
  `sharkcraft.surface.not-enabled.v1`. Distinguishes "command
  exists but is gated" from "unknown command". Same shape returned
  on MCP.
- **Project shape auto-detection** — `single-app`,
  `app-with-libs`, `monorepo`, `library`, `unknown`. Cached at
  `.sharkcraft/shape.json`. Doctor prints a shape + surface
  totals line. Documented in `docs/project-shape.md`.
- **MCP tier gating** — every `CallTool` consults the same surface
  resolver as the CLI. Experimental tools return the structured
  error with `isError: true`. Bootstrap tools always pass through.
  `get_command_catalog` exposes a `tier` field per entry.
- **Diff-aware `--since <ref>` on `shrk lint`** — accepts a git
  ref, reports the changed-file count, runs whole-graph lints with
  a notice. `shrk check boundaries --since` already filtered
  violations (R28); R56 makes the wiring uniform via the new
  `packages/cli/src/diff/collect-changed-paths.ts` helper.
- **`shrk` (no args) lands on a curated tiered view** — project
  shape + surface totals + top-4 recommended commands. The
  exhaustive `--help` view remains for power users.
- **`shrk --about`** — in-binary philosophy summary.
- **Local usage log** — `.sharkcraft/usage/commands.jsonl`,
  schema `sharkcraft.usage.v1`. One entry per invocation. Flag
  NAMES only (never values). Opt-out via `usage: { enabled: false }`
  in `sharkcraft.config.ts` OR `SHARKCRAFT_USAGE_DISABLED=1` env.
  Rotates at 10MB. Foundation for R57's `surface --suggest-prune`.
- **Doctor JSON surface block** — `surface` and `shape` blocks
  alongside the existing fields. `summary.advisoryCount` directly
  exposed on `IDoctorResult` (R49 already collapsed in text).

### Changed

- `shrk` (no args) no longer routes to `--help`. The bare form is
  the curated landing; `--help` / `-h` continue to print the
  exhaustive view.
- `sharkcraft.config.ts` gains optional `surface?: { enabled[];
  hidden[] }` and `usage?: { enabled }` blocks. Existing configs
  validate unchanged.
- `.sharkcraft/usage/` and `.sharkcraft/shape.json` added to the
  managed `.gitignore` block.

### Deferred to R57+

- `@shrkcrft/angular-app` preset (R57 forcing function).
- `shrk surface --suggest-prune` (reads R56's usage log).
- `shrk knowledge propose`, `shrk schema list`, editor/LSP.

## [Unreleased] — R55: honest verdicts + agent ergonomics + smaller surface

R55 closes the concrete still-present issues from the third feedback in
`feedbacks.md`: real correctness bugs in exit-code logic, the catalog
truth gap, the templates-update metadata/array-merge gap, and the two
agent-facing primitives the feedback explicitly asked for (`task
--next` and `apply --batch`). The visible CLI surface shrinks by one
top-level group (`dashboard`).

### Added

- **`shrk task --next`** — surveys the workspace (doctor, knowledge
  stale, template drift, knowledge lint) and proposes ONE
  highest-leverage next action with the exact command to run.
  Deterministic priority order (documented in
  `docs/dev-workflow.md`). JSON shape stable as
  `sharkcraft.task-next/v1`. Pure ranker over existing JSON outputs
  — no new asset kinds, no AI.
- **`shrk apply --batch <plan>.json`** — multi-step fix-chain runner.
  Reads a JSON plan of fix steps (`action-hints` /
  `knowledge-stale` / `template-drift`), executes each via the
  existing apply path, fails closed on first refusal unless
  `--allow-divergent`. Each batch carries a deterministic content-
  hash `batchId` so a future history view can group provenance.
  Supports `--dry-run` for plan validation without spawning.
- **`commands doctor --json` verdict field** — JSON now includes a
  top-level `verdict: 'clean' | 'drift'` and a `strict` flag.
- **`commands doctor --strict`** — promotes warnings to failing
  status. Without --strict, only errors fail the verdict.
- **`templates update --apply` array merge modes** — `--add-tag`,
  `--remove-tag`, `--set-tags` (and parallels for `scope` /
  `applies-when` / `related`). `{ mode: 'add' | 'remove' | 'set',
  values }` shape in the applier; bare arrays remain back-compat
  alias for `set`.
- **`templates update --apply` metadata splicing** — nested upserts
  for known scalar fields (`priority`, `maturity`, `dryRunOnly`,
  `requiresApproval`) and known array fields (`requiredAnchors`,
  `requiredProfileIds`, `forbiddenPathFragments`,
  `requiredVerificationCommandIds`). Creates the metadata block on
  demand when absent.
- **knowledge-stale file/directory rename heuristic** — `replaceWith`
  now also fires for `kind: 'file'` and `kind: 'directory'`
  references when the basename matches exactly one candidate with
  ≥1 overlapping parent-directory segment. Ambiguous or unrelated
  namesakes still decline the rename and fall back to drop.
- **`audit project-coupling` per-flag rationale line** — text and
  markdown outputs explain which category the `--fail-on` exit code
  is gating on with the current count.
- **`ISafetyAuditDeepReport.infoOnlyFindings`** — count of
  info-level findings (typically dev-signed packs). Schema bumped
  to `sharkcraft.safety-audit-deep/v2`. The text rendering adds a
  rationale line when dev-signed packs are present so `passed: yes`
  alongside a non-empty dev list stops reading contradictory.

### Changed

- **`CouplingExternalizationTarget.Pack` → `.Engine`** — the bucket
  name now reflects the *source location* (in engine code, should
  be externalised) rather than the recommended target. Closes the
  user's mental-model mismatch from the third feedback.
- **`audit project-coupling --fail-on engine` exit code** — now
  category-specific: exits non-zero iff at least one hit has
  `externalizationTarget === 'engine'`. Pre-R55 it collapsed to
  `verdict === 'clean'`, which over-counted any high-risk hit.
- **`commands doctor`** — `unregistered-subcommand` and
  `missing-catalog-entry` promoted from `info` / `warning` to
  `error` severity, so the verdict matches reality. 3-level commands
  (e.g. `pack author status`) no longer trigger drift because the
  second token is an internal dispatcher, not a registered
  subcommand.
- **`shrk lint` JSON schema** → `sharkcraft.lint/v2`. The
  `knowledge.errors` field is gone (`KnowledgeLintSeverity` emits
  info / warning only; the hardcoded `0` was lying). Totals are
  derived from rules + templates errors.
- **`buildRenameSymbolPlan` schema** → `sharkcraft.knowledge-rename/v2`.
  `writePath` / `wrote` are gone (see Removed).
- **`shrk plan review` is now a registered subcommand** so the
  catalog and registry agree. The internal dispatcher in
  `planParentCommand` still works as a fallback.

### Removed

- **`shrk dashboard` (HTTP server)** —
  `packages/cli/src/commands/dashboard.command.ts` and
  `packages/cli/src/dashboard/dashboard-api-server.ts` are deleted
  along with their tests. No agent path, not in the spine. Read-only
  dashboard data is still available via the MCP `dashboard-summary`
  tool. Live dev sessions still use `live-session-server` via
  `shrk dev start`.
- **`shrk knowledge rename-symbol|rename-file|update-anchor --write`** —
  the patch-file output under `sharkcraft/knowledge-updates/` was
  inert (no consumer applied it). The verbs are now read-only
  preview. Use `shrk fix --knowledge-stale --apply` to land
  entry-side renames (R54/R55 emits `replaceWith` for the
  unambiguous cases).
- **R46 overlay entry `dashboard serve`** — removed alongside the
  command.
- **Catalog row `dashboard serve`** — replaced by an inline R55
  comment.

### Fixed

- **`insertField` (and the copy in `applyActionHintStub`)** — a
  latent bug stripped the closing `}` of the entry literal via
  `after.slice(range.indent.length)`. Existing tests only checked
  the inserted content's presence, so the broken generated TS went
  unnoticed. The fix preserves `after` verbatim; the inserted line
  ends with `\n + range.indent` so `}` re-lands on a properly
  indented line. Cascades to every `--apply` path that goes through
  the splicer.
- **Hardcoded `'pack'` strings in `audit.command.ts`** — switched to
  the renamed `'engine'` value so `--fail-on any` still works after
  the bucket rename.

### Notes

- Pre-existing `report *` variants (under `bundle`, `provenance`,
  `checks`, `biome`) and `bundle apply-assist --resume` were
  evaluated for pruning and kept: each is scoped to its own group
  with a documented consumer.
- `packages/dashboard` and `packages/dashboard-api` package
  directories were NOT deleted — separate web/api packages, not
  the CLI surface. A future round can revisit if they remain unused
  after the CLI removal.

## [Unreleased] — R54: rename-in-place + missing-barrel + prune

R54 closes only the high-value, low-risk items from the R53
next-round list per the reviewer's "less is more" stance. Symbol-
rename across source (would need a ts-morph AST pass), nested
metadata mutation, and a unified `lint --fix` were explicitly
deferred.

### Added

- **`replaceWith` on `IKnowledgeReferenceCheck`** in
  `@shrkcrft/inspector` — a structured `{ path | id | symbol;
  rationale }` payload. Emitted for `kind: 'symbol'` references when
  the symbol exists with the same name in exactly one other file
  under `packages/`. Ambiguous (multi-file) or absent (no file)
  candidates leave `replaceWith` undefined.
- **`shrk fix --knowledge-stale --apply` rename-in-place** — when a
  check carries `replaceWith`, the apply rewrites the reference's
  `path` / `id` / `symbol` field in place rather than dropping the
  element. Migration is the safe default; drops still require the
  explicit `--drop-stale` / `--drop-missing` flag. Provenance
  records `applied: 'rename' | 'drop'`.
- **`shrk fix --template-drift --apply` for `missing-barrel`** —
  creates the missing index file with a placeholder `export {};`
  body and `AUTO-CREATED` notice. The drift warning flips off
  because the file exists; the human populates the re-exports
  before the next drift run. Refuses pack targets and idempotent
  (refuses if the file already exists).

### Removed

- **`shrk watch`** and the `shrk watch integrity` subcommand. The
  individual commands all have `--watch` flags (R31): use `shrk
  doctor --watch`, `shrk lint --watch`, `shrk templates drift
  --watch`. Top-level reactive watcher was a thin wrapper that
  agents can't usefully consume.
- **`shrk doctor watch`** — 20-line trampoline that just forced
  `args.flags.watch = true`. Pure duplicate of `shrk doctor
  --watch`.
- `docs/watch-loops.md` (the only doc dedicated to these three).

### Preserved invariants

- No new MCP write tools.
- No fake-signing.
- `--apply` is preview-first; the `replaceWith` rename is strictly
  safer than the drop (no destructive default).
- No pack-source mutation from `--apply` paths.
- Layer order preserved.

## [Unreleased] — R53: apply parity + unified lint

### Added

- **`shrk fix --knowledge-stale --apply [--drop-stale] [--drop-missing]`** —
  in-place removal of the offending reference from the entry's
  `references[]` array. Preview-first, refuses pack-contributed
  sources, records provenance.
- **`shrk fix --template-drift --apply`** — in-place fix for
  `related-id-unresolved` (drops the unresolved id from the
  template's `related[]` array). Other drift codes stay preview-only
  (body issues require editing the `files()` resolver).
- **`shrk templates update --apply`** — splices the projected
  metadata fields (`name` / `description` / `tags` / `scope` /
  `appliesWhen` / `related`) into the existing template literal in
  place. Refuses pack-contributed templates and function-resolver
  replacement.
- **`shrk lint`** — unified lint aggregator over knowledge / rules /
  templates. `--kind`, `--strict`, `--fix-preview`, `--json`. Pure
  CLI aggregator; no new domain logic. Full surface in
  [docs/lint.md](./docs/lint.md).
- **Shared entry-aware mutator** at
  `packages/cli/src/asset-preview/entry-mutator.ts` — `findEntryRange`
  (extracted from the R52 action-hint splicer), `replaceScalarField`,
  `upsertScalarField`, `insertField`, `removeArrayEntries`,
  `removeStringFromArray`, `splitTopLevelCommas`. All three R53
  splicers consume these primitives.

### Preserved invariants

- No new MCP write tools.
- `--apply` is preview-first; refused targets block the whole apply
  unless `--allow-divergent` is set.
- No pack-source mutation from any CLI `--apply` path.
- All write paths record provenance to
  `.sharkcraft/asset-provenance.jsonl`.

## [Unreleased] — R52: authoring symmetry + doctor blockers + release handoff

### Added

- **`shrk rules add` / `shrk rules remove`** — authoring parity for
  rules. `rules add` forces `type='rule'` and delegates to the
  `knowledge add` pipeline (same preview path, same provenance).
  `rules remove` asserts the target id is a rule and refuses
  non-matching ids before delegating to `knowledge remove`.
- **`shrk templates update` / `shrk templates remove`** — authoring
  parity for templates. Drafts land under
  `.sharkcraft/authoring/templates/`. `remove` performs reverse-
  reference checking against pipelines, presets, knowledge entries
  (`references[kind=template]`), and pack-contributed template files;
  refuses unless `--force-preview` is set.
- **`shrk fix --action-hints --apply`** — splice stubbed `actionHints`
  blocks into the matching entries in `sharkcraft/knowledge.ts`.
  Preview-first under the hood; refuses on divergence unless
  `--allow-divergent`; refuses pack-source targets; records
  provenance per applied stub.
- **`shrk doctor --blockers`** — must-fix view in one flag. Composes
  with `--json` and `--watch`. Exit 0 iff zero blockers remain. Full
  definition in [docs/doctor.md](./docs/doctor.md).
- **`shrk packs signature-status --release-readiness`** — per-pack
  annotation of whether the current signature would block
  `release:preflight` (dev signature + missing
  `SHARKCRAFT_PACK_SECRET` = blocking).
- **`shrk release readiness` fail-closed on dev signatures** — emits a
  new `pack-signature-release` blocker when any pack is dev-signed and
  `SHARKCRAFT_PACK_SECRET` is unset. Downgrades to a warning when the
  secret is available (re-sign before tagging).
- **`shrk safety audit --deep` dev-signature line** — enumerates
  dev-signed packs in the deep-audit output (severity = `info`).

### Changed

- **Shared CLI authoring kit** at `packages/cli/src/authoring/` —
  extracted `detectAuthoringSource`, `writeAuthoringDrafts`,
  `multiFlagValues`, `parseReferenceSpec`. Knowledge / rules /
  templates authoring commands all import from the same module
  instead of duplicating the helpers.
- **`buildPackSignatureReleaseGate`** in `@shrkcrft/inspector` —
  extracted as a standalone gate so tests can exercise the
  dev-signature blocking logic without spinning up the full
  release-readiness pipeline.

### Preserved invariants

- No new MCP write tools. The action-hint apply lives on the CLI
  only.
- No fake-signing. `release:preflight` never auto-re-signs; it fails
  closed and prints the exact `shrk packs sign <pack>` command
  needed.
- No pack-source mutation from `--apply`. Pack-contributed entries
  are refused; users edit the pack source and re-sign explicitly.
- All write paths record provenance to
  `.sharkcraft/asset-provenance.jsonl`.

## [Unreleased] — R51: bounded loader + inspector cache

### Added

- **`safeImport` / `IImportContext`** in `@shrkcrft/core` — bounded
  `await import()` with a configurable per-asset timeout and an
  optional per-process dedup wrapper. Replaces every raw
  `await import()` in knowledge / templates / pipelines / presets /
  boundary loaders. A failed TS asset can no longer hang the host
  process by re-importing on a second call.
- **`createInspectorCache`** in `@shrkcrft/inspector` — persistent
  loader cache under `.sharkcraft/cache/inspector/v1/`. Entries are
  fingerprinted by path + mtime + size + sha256-prefix, store the last
  load status (`ok` / `failed` / `timeout`) and elapsed ms. A
  previously-failed asset is **skipped** on the next inspect (cached-
  skip) without re-triggering the import — that is the killer feature
  that stops a single broken pack file from breaking every subsequent
  command.
- **Per-loader diagnostics**: `ISharkcraftInspection.loaderDiagnostics`
  reports kind, origin, pack name, elapsed ms, status, count, warning
  count, large-file flag, slow flag, error message, and a suggested
  next command for any failure or slow loader.
- **CLI flags** on `shrk inspect` and `shrk doctor`:
  `--debug` surfaces the loader-timing table; `--no-cache` bypasses
  the persistent cache; `--loader-timeout <ms>` overrides the default
  8000ms per-asset bound.
- **Doctor errors** for any loader failure / timeout, with a `fix:`
  hint pointing at the right follow-up command — failed pack assets
  are now loud, not silent.
- **Unquarantined**: the 12 consumer-keyed inspector tests R50
  quarantined now run automatically whenever a sibling consumer
  checkout is present, with an opt-out env var for CI environments
  without one.

### Fixed

- **Consumer-repo inspect hang** — every `shrk --cwd <consumer-repo> ...` command
  (inspect, doctor, templates list, packs contributions, gen
  --dry-run, etc.) would either hang indefinitely or exit 0 with no
  output. Root cause: Bun's dynamic `import()` returns a never-
  resolving promise on the second import of a TS file whose first
  import rejected at parse time. A duplicate
  `export const noReexportProxy` declaration in an consumer pack's
  rules file was the trigger. R51 bounds every loader call with a
  timeout, dedups path-keyed imports for the duration of an
  inspection. Smoke results: all consumer commands return in 400–600ms
  with exit 0; the previously broken contribution surfaces as a
  clean doctor error.

### Changed

- `inspectSharkcraft({useCache})` defaults to **false** so MCP tools
  remain strictly read-only. CLI commands opt in to the cache.
- All built-in TS loaders (knowledge / templates / pipelines /
  presets / boundaries) accept an optional `{importContext}` second
  argument. The inspector creates one context per call; standalone
  callers fall back to a fresh `safeImport` (still bounded by the
  default 8000ms timeout).

## [Unreleased] — R47: universal adoption top-5

### Added

- **`shrk inspect`** now prints a structured **Detected** block:
  workspace flavor (Nx / Turborepo / workspaces / single package),
  package manager, frameworks, source / test / package / generated
  roots, build / test / typecheck / lint / start script names,
  ESLint / Biome / GitHub Actions / nx / turbo config presence, the
  recommended preset (top-1 from `recommendPresets()`), and an
  honest "not guessed" list. Same block is echoed by
  `shrk init --zero-config` so the user sees what zero-config init
  would do before opting into `--write`.
- **`shrk inspect --no-config`** and **`shrk doctor --no-config`** —
  graceful no-sharkcraft-folder mode. The verdict line is advisory
  and the exit code stays 0; the user is pointed at
  `shrk init --zero-config` as the next step.
- **Two canonical preset aliases**: `nest-service` (composes
  `nestjs-service`) and `angular-app` (composes `modern-angular`).
  Both surfaced via `shrk presets list` and pick-able by
  `shrk init --preset auto` for matching repos.
- **`shrk presets explain <id>`** — natural-language "when to use
  this preset" view with the composition chain, `appliesTo`
  translation, asset counts, and a "for this repo: rank N of M" line
  driven by `recommendPresets()`.
- **`shrk eslint rules`** — read-only inventory classifying every
  SharkCraft rule / path / boundary / check as **bridgeable** /
  **adjacent** / **not-bridgeable**.
- **`shrk eslint explain-limitations`** — prints the honest list of
  what cannot be bridged (plan signing, pack signatures, knowledge
  stale-check, template drift, self-config doctor) and what to keep
  in CI.
- **`shrk biome report`** — adjacent (not native) Biome diagnostics
  JSON converted from `shrk check boundaries --json`. Documented as
  adjacent in `biome explain-limitations`.
- **`shrk biome explain-limitations`** — Biome-specific bridge
  limitations.
- **`shrk eslint config` / `shrk biome config`** aliases for the
  respective `scaffold` verbs (the names match feature_47.md's
  preferred shape).
- **`sharkcraft.check-result/v1`** + **`sharkcraft.check-aggregate/v1`** —
  the universal check-result protocol. `findings` carry severity /
  file / line / column / ruleId / message / suggestedAction /
  safeToAutoFix. See `docs/check-result-protocol.md`.
- **`shrk checks import <file>`** — read a v1 report or auto-convert
  ESLint / Biome JSON and store it under `.sharkcraft/checks/`.
- **`shrk checks aggregate`** — rolls every imported result into a
  single `sharkcraft.check-aggregate/v1` payload (worst-wins status).
- **`shrk checks report [--format text|markdown|json]`** — render
  the rollup (or each individual result if no rollup exists).
- **`shrk checks convert eslint|biome <file>`** — one-shot
  conversion to v1; prints to stdout or writes to disk.
- **`shrk ci scaffold github-actions --quickstart`** dry-run output
  now labels **exact path**, **next command**, and an
  **Explanation of gates** block listing every step's purpose +
  whether it was enabled by detection or by an explicit flag.
- **Recommender miss penalty (−3 per missing `appliesTo` profile)** —
  prevents more-specific presets (e.g. `next-app: [HasNext, HasReact,
  IsFrontend]`) from outranking more-targeted ones (`react-app:
  [HasReact, IsFrontend]`) on partial-match repos.
- **Five `examples/adoption-*` fixtures** — `typescript-library`,
  `react-app`, `next-app`, `nest-service`, `nx-monorepo`. Each one
  pins a canonical-stack auto-pick.
- **Docs**: `docs/zero-config-init.md`, `docs/eslint-bridge.md`,
  `docs/biome-bridge.md`, `docs/github-action.md`,
  `docs/check-result-protocol.md`. Updates to `docs/start-here.md`,
  `docs/presets.md`, `docs/safety-model.md`.

### Constraints honored

- **No new MCP write tools.** R47 added no MCP tools.
- **No fake signing.** `packs signature-status` still surfaces stale
  signatures with the manual re-sign instruction.
- **No project-specific logic in engine.** `migrate project-coupling
  audit` engine-clean.
- **No changes under consumer-project source.** Verified by `git status` in
  the consumer checkout.
- **TS/JS first-class.** Every new surface ships in TS and only
  enriches the TS adoption story; the polyglot surfaces stay
  unchanged.

## [Unreleased] — R44: agent-friendly pack authoring and knowledge lifecycle

### Added

- **`shrk knowledge add | update | remove`** — structured, preview-only
  authoring of knowledge entries. Drafts land under
  `.sharkcraft/authoring/<op>-<id>.{draft.ts,manifest.json,md}`. Never
  mutates `sharkcraft/knowledge.ts` or pack source. `update` preserves
  unspecified fields (including arbitrary `metadata.*`). `remove`
  reports reverse references and refuses by default — prefers a
  deprecation suggestion (`--mark-deprecated`) over deletion; explicit
  `--force-preview` is required to preview deletion when referenced.
- **`shrk knowledge lint [--fix-preview]`** — classifies findings as
  `safe-mechanical-stub` / `needs-human-wording` / `should-acknowledge` /
  `obsolete-entry` / `stale-reference` / `missing-provenance` /
  `missing-action-hints`. Never fabricates prose — safe stubs carry
  explicit `TODO(field):` markers. `--fix-preview` partitions findings
  into safe stubs vs. TODOs vs. acknowledgements.
- **`shrk pack-author status | preview | pending | validate`** (alias:
  `shrk pack author <verb>`) — pack asset authoring workflow.
  Knowledge is the implemented kind in R44; the other 7 kinds
  (search-tuning, feedback-rule, agent-test, convention,
  task-routing-hint, registration-hint, scaffold-pattern) return an
  honest deferral with the right next-command list. Status surfaces
  contribution counts per kind, pending drafts, provenance ledger
  presence, and `SHARKCRAFT_PACK_SECRET` availability.
- **`shrk packs pending`** — alias for `shrk pack-author pending`. The
  combined pending view: modified pack asset files, drafts under
  `.sharkcraft/authoring/`, stale signature state, pending provenance,
  missing-secret guidance. Writes a signing TODO with
  `--write-todo`. Never signs.
- **Asset provenance ledger** — `.sharkcraft/asset-provenance.jsonl`.
  Append-only, local-only, JSONL. Recorded automatically by
  `shrk knowledge add/update/remove --write-preview`. Refuses to write
  outside `.sharkcraft/`. No telemetry.
- **`shrk provenance list | show | report`** — query the ledger.
  Auto-detects source (`agent` / `cli`) from environment
  (`SHARKCRAFT_AGENT`, `CLAUDE_CODE_SESSION`, `ANTHROPIC_AGENT`); honours
  `$SHARKCRAFT_AUTHOR` / `$USER` for the `author` field.
- **Consumer pack template gap closure** — three new pack-only templates
  in `tools/sharkcraft-pack/src/assets/templates.ts`. Each emits a
  preview targetPath under `.sharkcraft/preview/<template-id>/` until
  the canonical consumer path is confirmed.
- **Knowledge-authoring dogfood** — a representative knowledge entry
  was authored end-to-end via `shrk knowledge add --write-preview`
  against an consumer codebase, validating the loop on a real entry.
  **No source under the consumer checkout was modified.**

### Changed

- `IDoctorCheck` rendering, `shrk packs signature-status`, and the
  existing R43 surfaces are unchanged. R44 strictly *adds* surfaces.
- `pack-signatures.md`, `safety-model.md` updated to document the
  combined pending view + the new authoring write surfaces.

### Schemas added

- `sharkcraft.knowledge-authoring/v1`
- `sharkcraft.knowledge-authoring-patch/v1`
- `sharkcraft.knowledge-lint/v1`
- `sharkcraft.knowledge-lint-fix-preview/v1`
- `sharkcraft.pack-author-status/v1`
- `sharkcraft.pack-author-preview/v1`
- `sharkcraft.pack-author-validate/v1`
- `sharkcraft.pack-pending/v1`
- `sharkcraft.asset-provenance/v1`
- `sharkcraft.asset-provenance-report/v1`

### Hard rules respected

- No new MCP write tools.
- No fake signing.
- No weakening of the safety audit.
- No project-specific logic in the SharkCraft engine.
- No changes under consumer-project source.
- Default behavior is preview-only on every new command.
- All generated drafts / patches live under `.sharkcraft/`.
- Tests cover every new public surface (40+ new tests across
  `packages/inspector/src/__tests__/r44-authoring-tooling.test.ts` and
  `packages/cli/src/__tests__/r44-cli-surfaces.test.ts`).

### Docs added

- `docs/knowledge-authoring.md`
- `docs/pack-authoring-workflow.md`
- `docs/asset-provenance.md`
- `docs/pack-signatures.md` — R44 combined pending section
- `docs/safety-model.md` — R44 authoring loop section
- `.sharkcraft/reports/r44-existing-surface-audit.md` (the Part 0 audit
  that drove this round)
- `.sharkcraft/reports/r44-final-report.md` (the round summary)

## [Unreleased] — R43: rule authoring, shape checks, codemod-assist, signature UX, warning quality

### Added

- **`shrk rules scaffold`** — emits a structured rule preview under
  `.sharkcraft/fixes/rule-<id>.preview.{ts,json,md}`. Preview-only by
  default; `--write-preview` materialises the three files. Knows the
  schema fields the agent must fill (`id`, `title`, `priority`, `scope`,
  `tags`, `appliesWhen`, `forbiddenActions`, `verificationCommands`,
  `examples`, `source.origin`, `metadata.advisory`). Kinds:
  `architecture | safety | style | governance | migration | testing | advisory`.
- **`shrk rules doctor`** — per-rule quality findings beyond the existing
  action-hint diagnostics: `vague-rule`, `missing-examples` (style /
  shape rules), `missing-owner`, `advisory-not-marked`,
  `advisory-has-unused-verification`,
  `verification-references-unknown-script`. Advisory rules (`metadata.advisory: true`)
  opt out of the verification axis.
- **`shrk checks list | doctor | run | parse-report`** — custom-check
  registry. Rules declare deterministic external checks via
  `metadata.checks: ICustomCheckDescriptor[]`. The engine never runs a
  command unless `--execute` is set explicitly. JSON report convention:
  `sharkcraft.custom-check/v1` (also accepts text fallback /
  exit-code-only).
- **`shrk codemod inventory | plan | checklist --rule <id>`** — codemod
  *assist*, **not** a codemod engine. Reads a custom-check report,
  groups affected files by risk (low/medium/high) using consumer counts,
  recommends an external tool (ts-morph / jscodeshift / eslint custom),
  and emits a project-script template under `.sharkcraft/fixes/`. The
  engine never rewrites source.
- **`shrk packs sign --if-needed | --check-only | --print-command | --write-todo`** —
  agent-friendly signing UX. Honest about missing `SHARKCRAFT_PACK_SECRET`
  (no fake signing); writes a signing TODO under `.sharkcraft/reports/`
  when `--write-todo` is set.
- **`shrk packs doctor --signature-explain`** — per-pack lifecycle states
  (`valid | unsigned | stale | invalid | secret-missing | not-required | unknown`),
  with a one-line explanation and the exact next command per pack.
- **`shrk doctor --explain-quality`** — surfaces the new
  `whyThisMatters` line on every action-hint warning so warnings stop
  becoming permanent yellow noise. Every action-hint warning also now
  carries `category`, `code`, and `recommendedFix`.
- **Consumer dogfood report** — the no-reexport-proxy workflow was
  walked end-to-end against a live consumer codebase. **No source
  under the consumer checkout was modified.**

### Changed

- `IDoctorCheck` extended with optional fields (`category`, `code`,
  `recommendedFix`, `whyThisMatters`, `advisory`). Backwards compatible
  — all fields optional.
- `actionHints`-derived doctor warnings carry the new fields by default,
  driving consistent renderer behaviour across `shrk doctor`,
  `shrk fix preview`, and `shrk rules doctor`.

### Hard non-goals (kept)

- No new MCP write tools.
- No fake pack signing.
- No weakening of the safety audit.
- No project-specific logic in engine packages.
- No source rewrite in `shrk codemod` (engine assists; rewrites stay external).

### Docs

- `docs/rule-authoring.md` (new) — scaffolding flow + schema cheatsheet.
- `docs/custom-checks.md` (new) — descriptor model + JSON report convention.
- `docs/codemod-assist.md` (new) — what the engine does and does NOT do.
- `docs/doctor-warning-quality.md` (new) — fields, render order, suppression.
- `docs/pack-signatures.md` (existing) — refreshed with R43 flags.
- `docs/safety-model.md` (existing) — confirms R43 honours every pillar.

## [Unreleased] — R41: command surface consolidation, product UX polish

### Added

- **Command-catalog R41 metadata.** `ICommandCatalogEntry` now carries
  optional `surface` (Primary | Common | Advanced | Machine | Internal |
  Legacy), `intendedAudience` (Human | Agent | CI | PackAuthor |
  Maintainer), `taskRole` (Start | Context | Search | Explain | Generate
  | Review | Validate | Release | Diagnose | Inspect), `preferredCommand`,
  `overlapsWith`, `replacedBy`, and `machineOnly`. Helper accessors
  (`commandSurface`, `commandAudience`, `commandTaskRole`,
  `commandUseWhen`) derive defaults from existing fields.
- **New `shrk commands` views** — no new top-level family:
  - `shrk commands surface [<primary|common|advanced|machine|internal|legacy>]`
  - `shrk commands machine` / `shrk commands legacy` / `shrk commands overlaps`
  - `shrk commands explain <cmd>` enriched with surface / audience /
    role / preferredCommand / overlapsWith / "Use this when…" block.
- **`docs/command-entrypoints.md`** — one-page canonical answer to
  "which command should I run first?".
- **`shrk commands ux-check` R41 checks** — `primary-without-audience`,
  `primary-without-role`, `machine-marked-primary`,
  `legacy-without-replacement`, `overlap-without-preferred`,
  `description-without-purpose`, `too-many-primary-for-role` (warnings).

### Changed

- **Shorter default human output.** `shrk recommend`, `shrk context
  --task`, `shrk task`, `shrk search`, and `shrk doctor` text modes
  default to verdict + top 3–5 items + next command + a one-line
  pointer to detail. `--verbose` / `--full` keep the long form. JSON /
  markdown / commands-first paths are untouched.
- **Banner wording aligned with R41 canonical-entrypoint message.**
  `entrypointBanner('recommend' | 'context' | 'task' | 'search' | 'why')`
  point operators back at `shrk recommend` for "what should I do?".
- **MCP descriptions.** `prepare_agent_task` is now explicit about
  being the canonical first call; `get_task_packet` and
  `get_relevant_context` defer to it.

### Notes

- No new MCP write tools. No changes under consumer-project source. R41 is
  pure consolidation — no command was renamed or removed.
- Release-preflight + 1248-test suite green.

## R38: connective tissue, self-policing, noise reduction

### Added

- **Self-config doctor v2** (`sharkcraft.self-config-doctor/v2`). Same
  `shrk self-config doctor` surface, now defaults to v2; pass
  `--schema v1` for the legacy shape. Adds cross-reference checks for
  agent-tests → helpers / playbooks / policies / commands, policies →
  rules / commands / paths, pipelines → templates / commands,
  playbooks → templates / pipelines, registration hints → templates /
  conventions / profiles, and decisions → rules / policies / files.
  Each finding carries `sourceKind / sourceId / targetKind / targetId /
  relation / file / message / suggestedFix / nextCommand / confidence`.
- **Doctor acknowledgements** layered on top of the R29 suppressions.
  - `shrk doctor acknowledge --id|--code|--category --reason "<text>" --expires-in 7d`
    writes a typed acknowledgement to
    `sharkcraft/doctor.suppressions.json`. Empty / TODO-prefixed
    reasons are rejected; missing expiry is rejected.
  - `shrk doctor acknowledgements list|check` lists / validates.
  - `shrk doctor --hide-acknowledged` shows only acknowledged entries.
  - `shrk doctor --fail-on-expired-acknowledgement` exits non-zero
    when any acknowledgement expired.
- **Import hygiene allowlist generator**:
  `shrk check imports --emit-allowlist <file> [--emit-allowlist-kind …]
  [--only-allowlist-candidates] [--fail-on-unexplained-allowlist]`.
  Draft entries carry a `TODO:` reason placeholder; strict mode
  refuses to apply allowlist entries whose reason is still TODO.
- **Apply dispatch trace** (`sharkcraft.apply-dispatch-trace/v1`).
  `shrk apply <plan> --trace` / `--explain-dispatch` and
  `shrk plan review <plan> --trace-dispatch`. Trace describes dispatch
  kind, op counts, plan-v2 operation kinds, signature status, safety
  gates, required flags, and final action.
- **Changed-only preflight orchestrator** —
  `shrk preflight [--since <ref>|--staged|--files a,b,c] [--profile quick|standard|strict] [--explain] [--json]`.
  Pure planner picks read-only gates from the changed-file shape;
  CLI runs the `Run` gates and surfaces `Recommend`.
- **Entrypoint matrix** — `shrk commands entrypoints` (alias:
  `shrk commands workflows`) renders four classes (human-interactive
  / agent-mcp / machine-json / debug-explainability). One-line
  entrypoint banners on `shrk task` / `shrk context` / `shrk recommend`.

### Changed

- **Pack contributions inventory** — new
  `buildPackContributionsInventoryAsync(inspection)` does
  structural-first extraction via the dedicated registries; regex
  fallback dedupes against `(kind, packageName||local, id)` so the
  same logical contribution doesn't double-count when reachable from
  multiple paths. Consumer inventory: 122 conflicts → 111 (11 errors → 0).
- **`shrk self-config doctor`** defaults to v2; `--schema v1` for the
  legacy shape.
- **`sharkcraft/rules.ts`** gets `writePolicy: 'cli-only'` on
  `repo.architecture.respect-layer-order`,
  `repo.discovery.read-examples-first` (also added
  `verificationCommands`), and `repo.testing.bun-only`. Clears all
  four long-standing action-hint quality warnings.
- **CLI command catalog** gains a `preflight` entry.

### Tests

- `packages/inspector/src/__tests__/r38-connective-tissue.test.ts` —
  22 deterministic tests covering acknowledgements, allowlist draft,
  strict-reasons, dispatch trace classifications, preflight planner,
  entrypoint matrix, and the engine-coupling regression guard.
- Full suite: **1200 / 1200 pass** (was 1178; +22).

### Safety / MCP / coupling

- No new MCP tools. No new write paths.
- `shrk safety audit --deep` passes.
- `shrk migrate project-coupling audit --fail-on engine` returns clean.
- Engine package scan returns no project-specific matches outside `__tests__`.

### Dogfood

- `shrk doctor` — 0 errors / 179 pack-rule warnings / 7 ok.
- `shrk self-config doctor` — 0 errors / 1 stale-signature warning / 8 info.
- `shrk check boundaries --changed-only` clean on 120 changed files.
- `shrk packs contributions` — 563 entries / 0 conflict-errors.
- Consumer-project source untouched.

### Reports

- `.sharkcraft/reports/r38-existing-surface-audit.md`
- `.sharkcraft/reports/r38-doctor-warning-fatigue.md`
- `.sharkcraft/reports/r38-import-hygiene-allowlist.md`
- `.sharkcraft/reports/r38-apply-dispatch-trace.md`
- `.sharkcraft/reports/r38-pack-inventory-v2.md`
- `.sharkcraft/reports/r38-changed-preflight.md`
- `.sharkcraft/reports/r38-entrypoint-clarity.md`
- `.sharkcraft/reports/r38-final-report.md`

## [Unreleased] — R37: import-hygiene strictness + lazy `require('node:*')` ban

### Changed

- **`require('node:*')` is now an `error`-severity finding** (was `warning` in R36). Node built-ins are resolved before any user code runs; lazy-loading them buys nothing and the customary `as typeof import('node:fs')` cast is a hack to satisfy strict TS where a top-level `import` would have typed the call for free. The `runtime-require` finding kind now reports `error` regardless of whether the spec starts with `node:`. The allowlist (with a required `reason`) remains the only legitimate escape hatch.
- **Engine-wide cleanup** — 23 production-code sites and 14 test sites previously used `const { ... } = require('node:fs') as typeof import('node:fs');` (or similar for `node:path`, `node:os`, `node:crypto`, `node:child_process`, `node:url`). All replaced with top-level ESM imports. The single retained `require('node:fs')` substring lives inside a *string-literal* test fixture in `r36-reliability-hardening.test.ts:72`.
- **Doctor comment** in `import-hygiene.ts` rewritten to explain the new policy in-line.
- **suggestedFix** text for `runtime-require` updated to explain that built-ins gain nothing from lazy require.

### Added

- **`repo.imports.no-lazy-node-builtin-require` rule** in `sharkcraft/rules.ts` (priority: `critical`). Documents the policy, lists forbidden actions, and pins `shrk check imports` as the verification command. Surfaces via `shrk context` / `shrk task` / `shrk recommend` so agents see the rule where they work. Knowledge entries count: **45 → 46**. AI-readiness: **72 → 73**.
- **`import-hygiene` preflight gate** — `scripts/release-preflight.ts` adds a new **required** step between `typecheck` and `tests` that runs `shrk check imports`. Any new lazy `require('./x')` or `require('node:fs')` blocks the release chain. Read-only; never writes.
- **`development/feature_37.md`** — round prompt file with the SKILL.md reference and the full task body (per the prompt-as-file contract).

### Tests

- `r37-no-lazy-node-builtin.test.ts` — 5 deterministic tests:
  - `require('node:fs')` is now `error`-severity (R37 policy).
  - Every Node builtin spec (`node:path`, `node:crypto`, …) flagged the same way.
  - Allowlist with documented `reason` still downgrades to `info`.
  - **Engine-wide regression guard**: `buildImportHygieneReport` against the actual repo returns **zero** `runtime-require` × `error` findings.
  - The `repo.imports.no-lazy-node-builtin-require` rule is loaded with the correct shape (priority, verification command, forbidden-action list).
- `r36-reliability-hardening.test.ts` — one existing assertion updated (`require(node:*)` is now expected at `error` severity, not `warning`).
- Overall test count: **1178 / 1178 pass** (was 1173; added 5 R37 tests).

### Safety / MCP

- No new MCP tools (read-only or otherwise).
- No new write paths; `shrk check imports` is read-only.
- No consumer-project source modifications.
- No fake signing.
- `shrk safety audit --deep` passes.

### Migration notes

- Local packs that previously contained `require('node:*')` patterns should convert to top-level imports. The checker will surface every such site under `shrk check imports`. If a particular usage is genuinely intentional (cold-path code-splitting on a non-builtin module), add an allowlist entry with a sentence-long `reason`. **Do not add allowlist entries for `node:*` builtins** — there is no legitimate reason.

## [Unreleased] — Developer loop, explainability, pack adoption, CI reporting (R31)

### Added

- **Ranker explainability** — `shrk why <id> --for-task "<task>"` and `shrk why-not <id> ...` (schema `sharkcraft.ranker-explainability/v1`) answer "why was X included/not for task Y?" without writing an agent test. Reports matched/missing signals, score, rank, threshold, outranked-by, search-tuning trace, suggested metadata fixes. `--kind` / `--for-query` / `--format text|markdown|html|json` flags. MCP: `get_ranker_explanation`, `get_ranker_why_not` (read-only).
- **Command discovery + did-you-mean** — `shrk commands suggest "<partial>"`, `shrk commands explain "<cmd>"`, and unknown-command did-you-mean hints. Typo-tolerant (`knowlege` → `knowledge`). `--safe-only` / `--mcp-safe-only` / `--category` filters. Group-level help via `shrk <group> --help` and `shrk help <group>`. MCP: `suggest_commands`, `search_commands`, `explain_command` (read-only).
- **Watch loops** — `shrk doctor watch [--once] [--debounce N]`, `--watch` flag on `shrk knowledge stale-check` / `shrk templates drift` / `shrk test agent`, and a combined `shrk watch integrity [--once]` that runs doctor + stale-check + drift + agent tests in one debounced loop. Linux fallback when recursive fs.watch is unsupported.
- **Fix preview system** — `shrk fix list|doctor|preview` (`--action-hints` / `--knowledge-stale` / `--template-drift`). Preview-only by default. `--write-preview` writes only under `.sharkcraft/fixes/`. Stubbed action-hint bodies are explicitly marked `needs-human-fill`; doctor continues to warn until filled. Schema: `sharkcraft.fix-preview/v1`. MCP: `preview_fix`, `list_fix_kinds` (read-only).
- **Scaffold coverage gap reporting** — `shrk coverage scaffolds --task "<task>"|--domain <domain>` (schema `sharkcraft.scaffold-coverage/v1`) reports per-axis coverage (knowledge / rules / paths / templates / scaffold-patterns / playbooks / helpers / validation-commands / contract-templates) + grade (full/partial/weak/missing) + suggested additions. Integrates into `shrk task --show-coverage-gaps`. MCP: `get_scaffold_coverage_report` (read-only).
- **Search-tuning explain CLI** — first-class top-level alias `shrk search-tuning <list|doctor|explain>` plus `--kind`, `--source`, `--limit`, `--format text|markdown|html|json` flags on the existing subcommand form.
- **Direct symbol impact / trace** — `shrk impact --symbol <Name>` and `shrk trace --symbol <Name>` use the AST-backed symbol index (`findSymbolInProject`) to walk the project, resolve exact-export / exact-local / probable-text matches, and run file-impact when exactly one exported declaration exists. `--language typescript|java|csharp|python|go|rust|auto` filter.
- **Changes summary** — `shrk changes summary [--since <ref>|--staged|--files a,b]` (schema `sharkcraft.changes-summary/v1`) groups the diff by package/area, flags MCP / safety-relevant / write-path / pack-asset files, classifies risk low/medium/high, and suggests validation commands. MCP: `get_changes_summary` (read-only).
- **PR summary generator** — `shrk pr summary [--since|--staged|--files] [--format markdown|json] [--output <file>]` (schema `sharkcraft.pr-summary/v1`) renders a deterministic PR description from the changes summary + reports under `.sharkcraft/reports/`. Sections: Summary, Why, What changed, Safety, Validation, Risk/review, Breaking, Migration, Known limitations, Follow-ups, Commands run, Reports. MCP: `get_pr_summary_preview` (read-only).
- **CI integrity report aggregator** — `shrk ci report [--reports-dir <dir>] [--format text|markdown|html|json] [--fail-on error|warning|none]` (schema `sharkcraft.ci-integrity/v1`) reads the JSON gates under `.sharkcraft/reports/` and renders a single overall verdict + per-gate breakdown + PR-comment-ready markdown. MCP: `get_ci_integrity_report` (read-only).
- **Failure-to-success hints** — `packages/cli/src/output/failure-hints.ts` centralizes next-command suggestions used by doctor / stale-check / template drift / ci report.
- **Uncertainty reporting** — `shrk task` always appends a confidence + uncertainty footer (`sharkcraft.uncertainty/v1`). Signals: no template / no path convention / no validation command / weak knowledge / low ranker confidence. `--show-coverage-gaps` includes the coverage report inline.
- **SharkCraft self-config polish (R31)** — 11 new knowledge entries (46 total, 112 references — all green via stale-check), 10 new search-tuning bias entries, 6 new agent-contract tests (18 pass).
- **Consumer pack adoption** — a representative consumer pack now ships dozens of path conventions and pack feedback rules covering common project-shaped concerns (boundary baseline noise, canonical path mismatch, template drift, etc.). Pack manifest accepts `feedbackRuleFiles[]`, `decisionFiles[]`, `pathConventionFiles[]` slots.

### Changed

- `shrk impact` accepts `--symbol <Name>` (was: path / specifier / fuzzy id only).
- `shrk trace` accepts `--symbol <Name>` (was: free-form query only).
- `shrk coverage` adds a `scaffolds` subverb.
- `shrk doctor` / `knowledge stale-check` / `templates drift` accept `--watch [--once] [--debounce N]`.
- `shrk task` always emits a confidence + uncertainty footer; `--show-coverage-gaps` adds the coverage report inline.

### Safety

- All R31 MCP tools are read-only; safety audit confirms zero write-capable MCP tools.
- `shrk fix preview --write-preview` writes only under `.sharkcraft/fixes/`; never modifies source.
- Unknown commands print did-you-mean suggestions but never execute the suggested command — humans run the CLI.
- Consumer pack signatures are intentionally stale after R31 adoption (no fake signing). Re-sign locally with `SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign ...`.

## [Unreleased] — CI gates, fuzzy impact, strong agent tests, knowledge integrity hardening (R30)

### Added

- **Fuzzy `shrk impact <query>`** — `packages/inspector/src/fuzzy-impact.ts` (schema `sharkcraft.fuzzy-impact-resolution/v1`). The impact command now resolves free-form queries (file path, construct id, symbol, template/helper/playbook/knowledge/command id) via the same R29 resolver used by `shrk trace`. New flags: `--resolve` / `--resolve-only` / `--explain-resolution` / `--no-resolve`. Auto-runs impact only on exact / high confidence; surfaces alternatives otherwise. MCP: `get_fuzzy_impact_report` (read-only).
- **Stronger agent test expectations** — `IAgentContractTest` gains `expectedHelpers`, `expectedPlaybooks`, `expectedPolicies`, `expectedConstructs`, `expectedCommands`, `expectedKnowledge`, `minConfidence`, `mustNotInclude`. Async `loadAgentContractRegistries` pre-loads policy / playbook / construct id sets so the sync runner stays sync. SharkCraft self agent tests strengthened across rename / remove / renderer / editor / sandbox / helper / CLI / MCP / inspector / polyglot tasks.
- **Knowledge stale-check CI/preflight gate** — `shrk knowledge stale-check [--ci] [--strict] [--fail-on required|stale|missing|all] [--baseline <file>] [--report] [--format text|markdown|html|json] [--output <path>]`. Local mode stays non-blocking; `--ci` blocks on required-true reference failures; `--strict` blocks on any required failure; `--baseline` computes new-stale / new-missing / resolved diffs. Wires into `shrk release readiness --with-knowledge-check` and respects `sharkcraft.config.ts knowledgeCheck.{enabled,strict,failOn}`.
- **AST-backed symbol verification** — `packages/inspector/src/symbol-index.ts` (schema `sharkcraft.symbol-index/v1`) uses the TypeScript compiler (`createSourceFile`) to parse single files and resolve symbols as `exact-export | exact-local | exact-reexport | probable-text | missing | unknown`. No full-program type-checking, no new dependencies (typescript is already present). Falls back to the R29 text scan when parsing fails. `shrk knowledge stale-check` now uses it for `kind: symbol` references.
- **Template drift severity controls** — `shrk templates drift` gains `--min-severity error|warning|info`, `--hide <code>[,<code>...]`, `--strict`, `--ci`, `--format text|markdown|html|json`, `--report`, `--output`. Strict mode promotes warnings to errors for exit-code purposes only.
- **Pack-contributed feedback rules** — `IFeedbackRule` (schema `sharkcraft.feedback-rule/v1`). Loaded from `sharkcraft/feedback-rules.ts` + pack `feedbackRuleFiles[]`. New CLI: `shrk feedback rules list|doctor`, `shrk feedback ingest <file> --with-pack-rules`, `shrk feedback actions <file> --with-pack-rules`. SharkCraft local rule pack (8 rules) covers fuzzy-impact / knowledge-ci / template-drift / agent-test-ranker / changed-only / mcp-readonly / warning-noise / feedback-rules. MCP: `list_feedback_rules`, `get_feedback_rule` (read-only).
- **TypeScript decisions loader** — `loadTsDecisions` reads `sharkcraft/decisions.ts` + pack `decisionFiles[]`. Markdown ADRs remain primary; TS entries fold in via cache. Duplicate ids skip with markdown winning. New: `shrk decisions doctor` validates id uniqueness + presence of Context/Decision/Consequences. SharkCraft self ships 10 TS decisions in addition to the 12 markdown ADRs. MCP: `get_decisions_report` (read-only).
- **CI scaffold integrity gates** — `shrk ci scaffold <provider> --with-knowledge-check --with-template-drift --with-integrity` adds the R29/R30 integrity gates to generated CI workflows. Each gate writes JSON under `.sharkcraft/reports/` for artifact upload symmetry.
- **SharkCraft self-config polish** — 8 new R30 knowledge entries (35 total, 77 references — all green via stale-check). 9 new search-tuning bias entries covering R30 surface. 8 R30 feedback rules. 10 R30 TS decisions. 4 new strict agent-test expectations across the 12 existing tests.
- **MCP — 4 new read-only tools** — `get_fuzzy_impact_report`, `list_feedback_rules`, `get_feedback_rule`, `get_decisions_report`. All read-only; no write capability added.

### Changed

- `shrk impact <input>` extends positional handling to accept fuzzy queries via the resolver, in addition to file paths and import specifiers. Default behaviour for existing file/specifier callers is unchanged.
- `shrk decisions list` warms the TS cache so TS decisions fold in alongside markdown ADRs.

### Safety

- All R30 MCP tools are read-only; safety audit confirms 0 write-capable MCP tools.
- `shrk knowledge stale-check` default mode is non-blocking; CI gating is opt-in via flags or `knowledgeCheck.{enabled}` config.
- `shrk templates drift --strict` promotes warnings → errors for exit code only; nothing is written.
- CI scaffold gates are explicit opt-in flags; no behaviour change for existing `--with-*` flags.
- Consumer-project source is **not** modified by R30. Recommended consumer pack additions (path conventions, feedback rules) are documented as advisory reports under the consumer's `.sharkcraft/reports/` directory.

### Tests

- +21 R30 tests covering fuzzy impact resolution (7), AST symbol index (7), feedback ingestion with pack rules (3), strict agent contract expectations (5). Total suite: **1081/1081 pass**.

## [Unreleased] — Changed-only quality v2 + knowledge integrity + template drift + SharkCraft self-improvement (R29)

### Added

- **Changed-only quality model v2** — `packages/inspector/src/changed-scope.ts` with `IChangedScopeClassification` (schema `sharkcraft.changed-scope/v1`) and buckets `new-in-changed-file | existing-touched | existing-untouched-hidden | resolved | unknown | unchanged | out-of-scope`. Wired into `shrk policy run` and `shrk drift` via `--changed-only|--since|--staged|--files`.
- **Doctor warning noise control** — `shrk doctor --focus errors,warnings-new,info | --hide action-hint-quality,... | --quiet-known`. `shrk doctor suppress` and `shrk doctor suppressions list|check`. Persistence: `sharkcraft/doctor.suppressions.json` (schema `sharkcraft.doctor-suppressions/v1`). Errors are NOT suppressed unless `allowError: true`. Expired suppressions surface as a warning.
- **Knowledge references + anchors** — `IKnowledgeEntry.references[]` (`file | directory | symbol | command | template | playbook | construct | helper | policy | boundary-rule | path-convention | package | url`) and `IKnowledgeEntry.anchors[]` (`file | symbol | command | construct | template | helper | playbook | policy`). Backwards-compatible — pre-R29 entries still load.
- **Knowledge stale-check** — `shrk knowledge stale-check [--changed-only|--since|--staged|--files]`, `shrk knowledge verify`, `shrk knowledge references <id>`, `shrk knowledge anchors`. Schema: `sharkcraft.knowledge-stale/v1`. No network, no AI. Symbol checks use deterministic text scan with confidence `exact | probable | missing | unknown`.
- **Knowledge rename / anchor drift advisory** — `shrk knowledge rename-symbol <old> <new>`, `shrk knowledge rename-file <old-path> <new-path>`, `shrk knowledge update-anchor <anchorId> [--to-symbol|--to-path|--to-target-id <value>]`. Dry-run by default; `--write` saves patches under `sharkcraft/knowledge-updates/`.
- **Template drift verification** — `shrk templates drift [--template <id>] [--pack <packId>]`, `shrk templates verify-paths`, `shrk templates smoke`. Schema: `sharkcraft.template-drift/v1`. Checks forbidden legacy fragments, missing barrels for `export` ops, missing anchors, unresolved related ids.
- **Anchor-aware barrel insert** — `buildBarrelExportOperation({ targetPath, from, symbol?, sort: 'alphabetic'|'append', group?, idempotencyMarker? })`. Detects duplicate exports, alphabetic insertion target, ambiguous-style conflicts (`export *` mixed with `export { ... }` for the same source).
- **Fuzzy trace** — `shrk trace <query> [--deep] [--limit <n>] [--kind file|construct|knowledge|template|helper|playbook|policy|command]`. Resolves any free-form query against multiple registries with confidence `exact | high | medium | low | unknown` and surfaces alternatives.
- **Feedback ingestion** — `shrk feedback <ingest|summarize|actions|convert-to-backlog> <file>`. Deterministic keyword/rule-based extractor — no AI. Schema: `sharkcraft.feedback-ingestion/v1`. Detects changed-only asks, stale knowledge, template drift, warning noise, fuzzy-trace asks, registry lifecycle, polyglot terms.
- **SharkCraft self policies** — `sharkcraft/policies.ts` with 11 policies: `mcp-read-only`, `apply-requires-explicit-verify-for-signed-plans`, `no-destructive-without-approval`, `ingest-adopt-allowlist`, `plan-v2-no-hidden-side-effects`, `contract-gate-opt-in-but-strict-when-used`, `helper-preview-only-mcp`, `language-runner-allowlist`, `memory-local-only`, `template-drift-must-be-detectable`, `mcp-read-only-comment`. All pass.
- **SharkCraft self decisions/ADRs** — `sharkcraft/decisions/` with 12 ADRs: `mcp-read-only-forever`, `plan-v2-no-delete-op`, `ingest-adopt-stub-bodies`, `changed-only-per-file`, `contract-gates-are-opt-in`, `memory-is-local-only`, `helpers-produce-plans-not-writes`, `polyglot-support-is-advisory-until-enforced`, `template-drift-checks-before-trust`, `knowledge-is-verifiable-not-tribal`, `no-auto-publish-no-auto-tag`, `pack-assets-are-contracts`.
- **SharkCraft self agent tests** — `sharkcraft/agent-tests.ts` with project-shape-relevant tests: add a new CLI command / MCP tool / inspector module, fix changed-only boundary, add polyglot Java support, debug ModuleNotFoundError. All pass.
- **SharkCraft self scaffold patterns** — `sharkcraft/scaffold-patterns.ts` with 8 patterns: `sharkcraft.cli-command`, `sharkcraft.mcp-tool`, `sharkcraft.inspector-module`, `sharkcraft.command-catalog-entry`, `sharkcraft.json-schema`, `sharkcraft.docs-page`, `sharkcraft.policy`, `sharkcraft.decision`. Loader extended to read local `sharkcraft/scaffold-patterns.ts` (was pack-only).
- **SharkCraft self knowledge entries** — `sharkcraft/knowledge.ts` with 16 R29 entries describing the engine surface, each with structured `references[]`. 48 references, all verified by `shrk knowledge stale-check`.
- **SharkCraft self search tuning** — `sharkcraft/search-tuning.ts` with 16 bias entries spanning the R28 consumer surface, SharkCraft engine, and polyglot terms.
- **MCP — 8 new read-only tools** — `get_doctor_suppressions`, `get_doctor_filtered_report`, `get_knowledge_stale_report`, `get_knowledge_references`, `preview_knowledge_rename`, `get_template_drift_report`, `resolve_query`, `trace_query`, `preview_feedback_actions`. All read-only; no write capability added.

### Changed

- `shrk policy run` and `shrk drift` accept `--changed-only|--since <ref>|--staged|--files a,b,c`. The default behaviour is unchanged.
- Top-level CLI dispatch falls through to a top-level handler when the second arg starts with `-` (lets `shrk doctor --hide ...` work alongside `shrk doctor <subcommand>`).

### Safety

- All R29 helpers default to dry-run / plan generation. The MCP read-only invariant is enforced by the new `sharkcraft.mcp-read-only` local policy.
- `shrk doctor suppress` writes only under `sharkcraft/doctor.suppressions.json` (a config file, not source).
- `shrk knowledge rename-*` writes only under `sharkcraft/knowledge-updates/` when `--write` is passed.

### Tests

- +20 R29 tests covering changed-scope classification, doctor suppression, knowledge stale-check, template drift, barrel operations, fuzzy resolver, feedback ingestion. Total suite: 1060/1060 pass.

## [Unreleased] — polyglot enforcement + task understanding v2 + signed ingest apply (R27)

### Added

- **Language-aware repository knowledge model** — `IRepositoryKnowledgeModel` (`sharkcraft.repository-knowledge-model/v1`) now carries `languageProfiles`, `languageCommands`, `polyglotDependencySummary`, `polyglotTestImpactSummary`, `languageBoundarySuggestions`, `polyglotBoundaryReport`, `languageRiskNotes`, `languageGeneratedCodeSignals`, `languageStabilitySignals`. `IngestDepth.Deep` and `IngestDepth.Extreme` now drive deeper scans (deeper marker scan + dep summary + boundary report + annotation-based stability classification). Module: `packages/inspector/src/repository-knowledge-model.ts`.
- **Polyglot boundary enforcement** — `IPolyglotBoundaryReport` (`sharkcraft.polyglot-boundary-report/v1`) evaluates conservative built-in rules per language against the polyglot dep scan. New CLI: `shrk boundaries enforce --language all|java|csharp|python|go|rust`, `shrk languages boundaries`, `shrk check boundaries --polyglot`. Built-in rules: Java domain/no-spring-web, controller/no-repository-direct, main/no-test-import; C# domain/no-aspnet, web/no-infrastructure-direct, main/no-test-import; Python domain/no-web-framework, app/no-tests-import, no-cross-layer-parent-relative; Go pkg/no-cmd-import, internal/visibility, no-import-cycle-hint; Rust lib/no-tests-import, no-test-only-module-import, no-super-cross-crate-hint. MCP: `get_polyglot_boundary_report` (read-only). The existing TypeScript boundary engine is unchanged.
- **Language-aware memory index** — `IRepositoryMemoryIndex` (`sharkcraft.memory/v1`) gains `languageByFile`, `riskyFilesByLanguage`, `diagnosticsByLanguage`, `boundaryViolationsByLanguage`, `validationFailuresByLanguage`, `planConflictsByLanguage`, `languageHotspots`, `languageRiskTrend`. Memory still never lowers base risk; the hotspot list raises it.
- **Task understanding v2** — `shrk understand-task "<task>" [--explain]` and `shrk context build [--explain]` now use construct vocabulary, language vocabulary, symbol matching, stability-aware boosts, dependency-graph proximity, memory hotspot signal, generated-code exclusion, path-convention boost, pack-contributed construct/facet boost. Output includes `likelyFiles` with reasons, `likelyConstructs`, `likelyLanguages`, `likelyTests`, `riskyGeneratedFiles`, `stabilityWarnings`, `memoryWarnings`, `suggestedFirstCommands`, `confidence` (0–100).
- **Stability map v2** — `buildStabilityMap` accepts `scanAnnotations: true`; recognises `@deprecated`/`@experimental`/`@internal` JSDoc, Java `@Deprecated`, C# `[Obsolete]`/`[EditorBrowsable(Never)]`, Python `warnings.warn(..., DeprecationWarning)` / `# DEPRECATED`, Rust `#[deprecated]` / `#[doc(hidden)]` / `#[unstable]`, Go `// Deprecated:`. Driven by depth — turned on automatically at `IngestDepth.Deep`/`Extreme`.
- **Generated-code report v2** — `IBuildGeneratedCodeReportOptions.depth: GeneratedScanDepth` (standard / deep / extreme). New `GeneratedKind`s: `JavaGenerated`, `CSharpGenerated`, `PythonGenerated`, `GoGenerated`, `RustGenerated`. Per-language markers (Java `@Generated`/`javax.annotation.Generated`, C# `[GeneratedCode]`/`<auto-generated/>`, Python `# @generated`, Go `Code generated .* DO NOT EDIT`, Rust `bindgen`). Generated source roots: `target/generated-sources`, `target/generated-test-sources`, `build/generated`, `obj/`, `.openapi-generator/`, `prisma/generated`.
- **Ingest adoption apply plan** — `shrk ingest adopt plan | review | apply` reuses the existing `sharkcraft.plan/v1` schema + HMAC signing. Plans only target `sharkcraft/**` and `sharkcraft/docs/tasks/**`; the apply step refuses any other target. Default is dry-run; `--verify-signature` requires `SHARKCRAFT_PLAN_SECRET`. MCP: `preview_ingest_adoption_plan` (read-only, never persists).
- **Polyglot CI for all providers** — `shrk ci scaffold <provider> --polyglot` now emits per-language jobs/stages/steps for GitHub Actions / GitLab / Bitbucket / Azure DevOps / Jenkins. No publish / deploy / push commands.
- **Safe language command runner** — `shrk languages run [--category test|build|lint|format|check|typecheck|all] [--language <id>] [--command-id <lang.cat>] [--all-tests] [--execute] [--allow-install] [--report]`. Dry-run by default; execution is CLI-only. Refuses commands that match `publish/deploy/release/push/sudo/rm -rf /` patterns. MCP: `get_language_run_plan` (plan only — never executes).
- **Language profile cache** — `.sharkcraft/languages/cache.json` (`sharkcraft.language-cache/v1`). Opt-in via `--cache`; `--refresh-cache` rewrites the cache after detection. New: `shrk languages cache status | clear [--write]`. Stale-cache detection compares manifest mtimes/sizes + per-extension file counts/latest mtimes against the live tree. MCP: `get_language_cache_status` (read-only).
- **Polyglot impact integration** — `shrk impact <file>` appends a polyglot block for non-TS files: per-language files / likely tests / verification commands / boundary concerns / external deps.
- **Reports / dashboard / map** — `shrk report language` accepts `--include-boundaries` and `--include-memory`. `shrk dashboard-export` writes `languages.json`. `shrk report site` writes a `languages.html` page. `buildRepositoryMap` carries `languageCounts`.
- **MCP — 5 new read-only tools** — `get_polyglot_boundary_report`, `preview_ingest_adoption_plan`, `get_language_run_plan`, `get_language_cache_status`, `get_language_profiles_live`. All return data + a next-command hint; none write.

### Safety

- The MCP read-only invariant remains intact (audit gate unchanged). No new MCP write tools.
- `shrk languages run` is dry-run by default; execution requires `--execute`; install/restore are gated behind `--allow-install`; publish/deploy/push commands are refused even with `--execute`.
- `shrk ingest adopt apply` only writes under `sharkcraft/**` and `sharkcraft/docs/tasks/**`; every other target is refused. With `--verify-signature` the apply step requires an HMAC signature matching `SHARKCRAFT_PLAN_SECRET`.
- Language cache writes only to `.sharkcraft/languages/cache.json`. `shrk languages cache clear` is dry-run by default.
- No new auto-execution paths. No new publish/tag flows.

## [Unreleased] — repository knowledge model + ingest + Modern Angular preset (R26)

### Added

- **Repository knowledge model** — `IRepositoryKnowledgeModel`, schema `sharkcraft.repository-knowledge-model/v1`. Composes onboarding inference + architecture map + area map + construct registry + contradictions + generated-code report + stability map into a single deterministic model. Module: `packages/inspector/src/repository-knowledge-model.ts`. Sections: `repositoryOverview`, `architectureModel`, `businessLogicModel`, `rulesAndConventions`, `dependencyBoundaries`, `domainMap`, `workflowMap`, `changeProtocol`, `riskAreas`, `contradictions`, `openQuestions`, `generatedVsHandwritten`, `stableExperimentalDeprecated`, `taskContextHints`, `recommendedSharkCraftFiles`. Confidence + limitations + transformational-intent metadata.
- **`shrk ingest` command group** — `shrk ingest repository | refresh | status | report | adopt | diff | clean`. Dry-run by default. `--write-drafts` writes 26 draft files under `sharkcraft/ingestion/` (per-section markdown + 10 `*.draft.ts` files for knowledge/rules/paths/boundaries/constructs/policies/playbooks/templates/pipelines/presets). `--adopt` writes a patch + plan + summary under `sharkcraft/ingestion/adoption/` (never overwrites live `sharkcraft/*.ts`). Flags: `--preset` (repeatable), `--profile`, `--include`/`--exclude` (sections), `--depth shallow|standard|deep|extreme`, `--docs-first`, `--task`, `--format`, `--output`, `--json`.
- **Contradictions engine** — `IContradictionReport`, schema `sharkcraft.contradictions/v1`. Detects missing path references, deprecated CLI usage (`sharkcraft <verb>` → `shrk <verb>`), and missing script references in shell-fenced doc commands. CLI: `shrk contradictions [--format text|markdown|html|json]`.
- **Generated-code classifier** — `IGeneratedCodeReport`, schema `sharkcraft.generated-code/v1`. Detects `@generated`/`DO NOT EDIT`/OpenAPI/GraphQL/protobuf/Prisma banners, lockfiles, Angular env files, and generated roots. Recommends protect rules + policy gates. CLI: `shrk generated report|protect --write-drafts`.
- **Stability map** — `IStabilityMap`, schema `sharkcraft.stability-map/v1`. Classifies areas as `stable`/`experimental`/`deprecated`/`legacy`/`generated`/`internal`/`public-api`/`high-risk`. Signals: folder names, index-barrel presence, generated-root membership, fan-in (when import graph is available). CLI: `shrk stability map|area <id>`.
- **Task-specific context commands** — `shrk understand-task "<task>"`, `shrk validate-change [--files] [--since] [--staged]`, `shrk context build/refresh/status`. `understand-task` wraps task-packet + change-intent + risk + brief + knowledge model to return intent + relevant rules + likely files + risks + required validations + next safe command. `validate-change` surfaces boundary-suspect edits, generated-file edits, missing tests, and doc contradictions touched by the change. `context build` saves a per-task bundle under `.sharkcraft/context/task-contexts/<slug>.json` + `.md`.
- **R26 presets** — 26 new built-in presets: `generic-safe-repo`, `ai-agent-safe-development`, `enterprise-review-gated`, `strict-typescript`, `node-service`, `npm-package`, `modern-angular`, `angular-signals-first`, `angular-rxjs-disciplined`, `angular-standalone-components`, `angular-enterprise-architecture`, `angular-performance`, `angular-testing`, `angular-accessibility`, `angular-security`, `angular-enterprise-app`, `angular-library`, `vitest-focused`, `jest-focused`, `playwright-focused`, `react-app`, `vue-app`, `web-component-library`, `nestjs-service`, `express-service`, `fastify-service`. Modern Angular preset ships 14 representative rules (signals/RxJS/forms/routing/security/a11y). Strict-TypeScript preset ships 11 rules (any/satisfies/discriminated unions/promises/imports/branding).
- **MCP — 11 new read-only tools** — `create_repository_ingestion_plan`, `get_repository_knowledge_model`, `get_repository_ingestion_status`, `get_repository_ingestion_report`, `get_contradiction_report`, `get_generated_code_report`, `get_stability_map`, `get_ingest_adoption_preview`, `understand_task`, `get_task_context`, `validate_change_context`. All return data + a next-command hint; none write.
- **Fixtures** — `examples/ingest-angular-modern`, `examples/ingest-typescript-library`, `examples/ingest-layered-service`, `examples/ingest-docs-contradiction`, `examples/ingest-generated-code`.

### Safety

- `shrk ingest repository` is dry-run by default; `--write-drafts` only writes under `sharkcraft/ingestion/`; `--adopt` only writes under `sharkcraft/ingestion/adoption/`. Live `sharkcraft/*.ts` files are never overwritten.
- All R26 MCP tools are read-only. The MCP audit invariant is preserved.
- Pack signing, plan signing, apply gates, and contract approval flow are unchanged.
- The `shrk context --task "..."` flat usage continues to work; `build`/`refresh`/`status` are dispatched only when the first positional matches.

## [Previously released] — polyglot support + contract precision + memory drift (R25)

### Added

- **Polyglot language detection** — new `shrk languages detect` (also `shrk report language`). Detects TypeScript / JavaScript / Java / C# / Python / Go / Rust by scanning canonical build/manifest files and counting source files. Reports per-language `confidence`, `sourceRoots`, `testRoots`, `buildFiles`, `testFrameworks`, `frameworkSignals`, `likelyCommands`. Module: `packages/inspector/src/languages/`. Schema: `sharkcraft.language-profile/v1`. MCP: `get_language_profiles`, `get_language_report` (read-only).
- **Polyglot command inference** — `shrk languages commands` produces per-language `install` / `restore` / `typecheck` / `test` / `lint` / `format` / `build` / `package` / `run` commands. Covers Maven, Gradle, dotnet, pip / poetry / uv (pytest / ruff / mypy), go, cargo. Schema: `sharkcraft.language-command-set/v1`. MCP: `get_language_commands` (read-only).
- **Polyglot dependency scanner** — `shrk languages deps [--language all|java|csharp|python|go|rust]` parses imports for the supported languages using deterministic regex rules. Distinguishes internal vs external dependencies via package/namespace/module declarations. Schema: `sharkcraft.polyglot-dependency-graph/v1`. MCP: `get_polyglot_dependency_graph` (read-only).
- **Polyglot test impact** — `shrk languages tests --files a,b,c` predicts per-language test files using deterministic naming conventions (`*Test.java`, `FooTests.cs`, `test_foo.py`, `foo_test.go`, `tests/foo.rs`). Schema: `sharkcraft.polyglot-test-impact/v1`. MCP: `get_polyglot_test_impact` (read-only).
- **Polyglot CI scaffold** — `shrk ci scaffold github-actions --polyglot` appends per-language jobs (Maven / Gradle / dotnet / Python / Go / Rust) when corresponding profiles are detected. Setup actions (`actions/setup-java`, `actions/setup-dotnet`, `actions/setup-python`, `actions/setup-go`, `dtolnay/rust-toolchain`). No publish / deploy steps. Other CI providers emit a guidance comment.
- **Polyglot boundary suggestions** — `shrk boundaries infer --language all|java|csharp|python|go|rust` adds per-language suggestion rules. Suggestions only — the existing boundary engine remains TS-aware.
- **Polyglot presets** — 7 new built-in presets: `java-maven-service`, `java-gradle-service`, `csharp-dotnet-service`, `python-service`, `go-module`, `rust-crate`, `polyglot-monorepo`.
- **Polyglot healing diagnostics** — 10 new diagnostic codes: `java-cannot-find-symbol`, `java-package-does-not-exist`, `csharp-cs0246`, `csharp-nu1101`, `python-module-not-found`, `python-pytest-collection-error`, `go-cannot-find-module`, `go-import-cycle`, `rust-e0432`, `rust-e0308`. `shrk heal from-error "<stderr>"` recognises each one.
- **Contract precision — glob-aware forbidden files** — new `IContractFileRule` (`kind: 'glob' | 'path-prefix' | 'exact' | 'contains'`) drives forbidden-files matching with deterministic glob support (`*`, `**`, `?`). `IAgentContract` now carries optional `allowedFilesDetailed?[]` / `forbiddenFilesDetailed?[]`. Legacy `forbiddenFiles: string[]` continues to work (treated as `kind: 'contains'`).
- **Contract approval expiry** — `shrk contract approve` accepts `--expires-in <duration>` (`30m` / `2h` / `7d` / `1w`) and `--expires-at <ISO>`. `shrk contract check` and `shrk contract status` now surface `approvalExpiry` with `valid` / `expires-soon` / `expired` / `no-expiry` / `absent`. High/critical-risk approvals without an expiry receive a warning.
- **Apply gate exit-code policy** — `shrk apply <plan> --contract <c> --json` now emits a structured `gateResult` block carrying `exitCategory` (`ok` / `blocked-contract-gate` / `blocked-signature` / `blocked-conflict` / `blocked-divergence` / `blocked-policy` / `blocked-boundary` / `blocked-validation` / `invalid-input`), `contractGateFailures[]`, `signatureStatus`, `suggestedNextCommand`. Exit code unchanged. Schema: `sharkcraft.apply-gate/v1`.
- **Memory drift / diff** — `shrk memory build --write-snapshot` archives the index under `.sharkcraft/memory/history/`. New `shrk memory diff <old.json> [new.json]` and `shrk memory drift [--previous <snapshot.json>]` compare two indexes and report `riskTrend` + new/resolved risky files + suggested actions. `shrk memory snapshots` lists the archive. Schema: `sharkcraft.memory-diff/v1`. MCP: `get_memory_diff`, `get_memory_drift` (read-only).
- **Contract templates** — 6 reusable templates: `ai-agent-safe-change`, `public-api-change`, `release-task`, `migration-task`, `security-sensitive-change`, `polyglot-service-change`. CLI: `shrk contract template list|get|render|recommend`. Schema: `sharkcraft.agent-contract-template/v1`. MCP: `list_contract_templates`, `get_contract_template` (read-only).
- **Execution graph DOT clustering** — `shrk agent graph "<task>" --graph-format dot --cluster` emits Graphviz subgraph clusters keyed by node kind. Stable colors + shapes. Plain `--graph-format dot` (no `--cluster`) is unchanged.
- **Report — language summary** — `shrk report language` emits a combined language report (profiles + commands + dependencies) in text / markdown / html / json.
- **Fixtures** — `examples/polyglot-{java-maven,java-gradle,csharp-dotnet,python-pytest,go-module,rust-cargo,mixed-service}`. Each is minimal: one source file, one test file, one build/manifest file. No installs, no build outputs.

### Safety

- MCP write-tool count unchanged: zero. All R25 MCP tools are read-only.
- Polyglot dependency scanner uses regex only; no compiler / AST integration. No new heavy runtime dependencies.
- `shrk memory build --write-snapshot` writes only under `.sharkcraft/memory/history/`.
- `shrk apply --contract` is still opt-in; the unflagged apply path is unchanged.
- Contract precision is fully backwards-compatible — old `forbiddenFiles: string[]` contracts still work.

### Catalog

- 9 new MCP tools registered in both `ALL_TOOLS` and `ALL_TOOLS_FOR_AUDIT`.
- New CLI surface: `shrk languages <detect|commands|deps|tests>`, `shrk memory <diff|drift|snapshots>`, `shrk memory build --write-snapshot`, `shrk contract template <list|get|render|recommend>`, `shrk contract approve --expires-in / --expires-at`, `shrk agent graph --cluster`, `shrk boundaries infer --language`, `shrk ci scaffold --polyglot`, `shrk report language`.

## [Unreleased] — memory-weighted risk + contract gates + handoff unification + plan-simulation diff + execution-graph DOT/query (R24)

### Added

- **Memory-weighted task risk** — `shrk risk "<task>" --include-memory` now actually adjusts the score. The report carries `baseScore` / `baseRiskLevel` / `adjustedScore` / `adjustedRiskLevel` and a `memory` block (`rawScore` / `score` / `level` / `signals[]` / `reasons[]` / `capped` / `cap` / `stale` / `missing`). Memory can raise risk but never lower it. Cap = 14. Stale index (>30 days) halves the adjustment. `shrk contract`, `shrk agent graph`, `shrk view <role>`, and `shrk orchestrate --risk-aware` now pass `includeMemory: true` automatically. MCP `get_task_risk_report` accepts `includeMemory`.
- **Contract gates** — new `shrk contract check <contract.json> [--plan …] [--approval …]`, `shrk contract approve <contract.json> --by … --reason …`, `shrk contract status <contract.json> [--approval …]`. The check validates 7 gates: `human-approval`, `required-plan-review`, `forbidden-files`, `required-validations`, `public-api-review`, `risk-approval`, `memory-elevated-approval`. Approvals are HMAC-signed when `SHARKCRAFT_CONTRACT_SECRET` is set. Schema: `sharkcraft.agent-contract-approval/v1` and `sharkcraft.agent-contract-gate/v1`.
- **Opt-in apply gate** — `shrk apply <plan> --contract <contract.json> [--approval <approval.json>]` enforces the contract before writing. Without `--contract` apply behaviour is unchanged.
- **Unified handoff** — `shrk handoff "<task>"` accepts `--include-contract`, `--include-brief`, `--include-execution-graph`, `--include-memory`, `--include-plan-simulation <plan.json>`, plus `--role` / `--mode`. The packet now optionally folds in the agent contract summary, the memory-driven warnings, the execution graph summary, and a plan-simulation summary. Backwards-compatible: every R24 field is optional in the JSON envelope. MCP `create_agent_handoff` accepts the same flags (read-only).
- **Plan simulation diff** — `shrk plan simulate <plan.json> --diff [--max-diff-lines N]` now reports `beforeLineCount`/`afterLineCount`, an `operationDetail` field per op kind (`append` / `insert-after` / `insert-before` / `replace` / `export` / `create` / `skip` / `conflict`), and a unified-diff preview (truncated when long). HTML output wraps each diff in a static `<details>` block — still no JavaScript.
- **Execution graph DOT + query** — `shrk agent graph "<task>" --graph-format dot` emits Graphviz `digraph`. New `shrk agent graph query <graph.json> "<filter>:<value>"` (supports `blocks:<id>`, `kind:<x>`, `edge:<x>`, `text:<substring>`). MCP `query_execution_graph` (read-only).

### Safety

- MCP write-tool count unchanged: zero. All R24 MCP tools are read-only — `get_contract_status`, `create_contract_approval_preview` (preview only, never persists), `query_execution_graph`.
- `shrk contract approve` writes only to the `--output` path the user supplies. No implicit write locations.
- Apply contract gate is opt-in. The pre-R24 `shrk apply <plan>` flow is unchanged.

## [Unreleased] — agent contract + plan simulation v2 + repo memory + self-healing + execution graph (R23)

### Added

- **Agent contract** — `shrk contract "<task>" [--role …] [--mode …]` builds a deterministic safety contract per task: allowed/forbidden files, allowed/forbidden commands, required validations / reviews / plan reviews, human approval gates, rollback plan, definition of done, relevant constructs / policies / boundaries / playbooks / templates, public-API risks, ownership review. Output as text / markdown / html / json. `--save` writes only under `.sharkcraft/contracts/`. MCP: `create_agent_contract` (read-only). Schema: `sharkcraft.agent-contract/v1`.
- **Plan simulation v2** — `shrk plan simulate <plan.json>` loads v1/v2 saved plans, reconstructs virtual contents when possible, classifies each operation (`ready` / `skip-idempotent` / `conflict` / `modifies-existing` / `creates-new`), and reports apply readiness (`ready / ready-with-review / blocked-conflicts / blocked-policy / blocked-boundary / blocked-signature / blocked-missing-review`). Detects public-API / barrel-export / feature-key-table / event-registry / token-registry / adapter-boundary / policy-owned / ownership-review touches. Flags: `--strict`, `--include-boundaries`, `--include-impact`, `--include-tests`, `--include-policies`, `--include-ownership`, `--include-memory`. Output as text / markdown / html / json. MCP: `simulate_plan` (read-only). Schema: `sharkcraft.plan-simulation/v1`.
- **Repo memory (local-only)** — `shrk memory build|report|risk|files|diagnostics|reset` produces a private, deterministic index at `.sharkcraft/memory/index.json` summarising frequently touched files, plans with conflicts, recurring boundary / policy violations, failed / slow validation commands, release blockers, pack issues, playbook outcomes, and high-activity constructs. `memory build` writes only to `.sharkcraft/memory/`; `memory reset` is dry-run by default and `--write` refuses to step outside `.sharkcraft/memory/`. **No network, no telemetry, no embeddings.** MCP: `get_memory_report`, `get_memory_risk`, `list_memory_files`, `get_memory_diagnostics` (all read-only). Schema: `sharkcraft.memory/v1`.
- **Self-healing plans** — `shrk heal from-error|from-file|from-report|from-command` builds an advisory `IHealingPlan` (likely causes, safe recovery steps, forbidden quick fixes, recommended commands, related docs / constructs, human-approval flag, next safest command). Reuses the existing diagnostics registry. Never auto-fixes, never writes source. MCP: `create_healing_plan` (read-only). Schema: `sharkcraft.healing-plan/v1`.
- **Task execution graph** — `shrk agent graph "<task>"` builds a typed node/edge graph that combines intent, risk, memory, contract, constructs, policies, boundaries, playbooks, templates, plans, review gates, human approval, validations, report artefacts, and done. Renderers: text / markdown / json / mermaid / html (HTML embeds the Mermaid source without JS). MCP: `create_execution_graph` (read-only). Schema: `sharkcraft.execution-graph/v1`.

### Safety

- MCP write-tool count unchanged: zero. All R23 MCP tools are read-only and registered in the audit list.
- `shrk contract --save` and `shrk memory build` write only inside `.sharkcraft/contracts/` and `.sharkcraft/memory/` respectively.
- `shrk heal` never auto-fixes and explicitly forbids `--no-verify` / silencing tests / committing secrets / deleting session state to "recover".
- All new commands are deterministic — no model calls, no network, no embeddings.

### Catalog

- 13 new entries in `packages/cli/src/commands/command-catalog.ts` covering `contract`, `plan simulate`, `memory *`, `heal *`, `agent graph`. `shrk commands doctor` reports the catalog as consistent.

## [Unreleased] — migration readiness + plan-review v2 surface (R22)

### Added

- **Migration readiness gates** — `shrk migration readiness --profile <id>` produces a deterministic, read-only verdict for multi-phase migrations. First profile gates the deletion of a legacy consumer CLI on signed pack + drift baseline + dedupe + script migration + MCP separation + retirement runbook. Verdict is one of `blocked`, `ready-except-{signing,baseline,dedupe,script-switch}`, `ready-to-deprecate`, `ready-to-delete`. Profiles are data-driven so new ones land without engine changes. MCP: `get_migration_readiness`, `list_migration_profiles`.
- **`shrk migration profiles`** — lists registered profiles (read-only).
- **Plan-review v2 kinds surfaced** — `shrk plan review <plan.json>` now renders `append` / `insert-after` / `insert-before` / `replace` / `export` entries with their own labels (previously collapsed to `unknown`). New `modifiesExisting: boolean` per file entry; summary counts (`creates`, `modifies existing`, `conflicts`); explicit `HUMAN REVIEW REQUIRED — N entry/entries modify existing files.` notice when N > 0.
- **Report-site construct page fix** — `shrk report site` now warms the construct cache before rendering. Repos whose constructs come via packs get a populated `constructs.html` instead of the authoring-guidance placeholder.

### Changed

- `IPlanReviewFile['type']` widened to include the v2 kinds (`append`, `insert-after`, `insert-before`, `replace`, `export`). Backwards-compatible: existing v1 plans continue to classify as `create` / `update` / `skip` / `conflict` / `unknown`.
- A representative consumer pack now ships a richer set of constructs and playbooks covering common project shapes (boundaries, public entrypoints, registries, CLI retirement, release gates).
- Consumer-local policies extended — guards for boundary mixes, missing public-entrypoint barrels, CLI retirement preconditions, and similar project-shape concerns.

### Safety

- MCP write tool count unchanged: zero.
- Migration readiness is read-only — probes local files / env vars / pack manifest existence. Never runs source.
- All new policies are `severity: warning`, `checkType: plan`. None executes commands.
- Plan-review classifier change does not alter what `shrk apply` will write — only the review surface.

## [Unreleased] — per-task risk + graph resolution + evidence hardening (R20)

### Added

- **Per-task risk model** — `shrk risk "<task>" [--files a,b,c] [--since <ref>] [--staged] [--json] [--explain]` produces an `ITaskRiskReport` derived from change intent + impact analysis + architecture signals + boundary violations + ownership impact + tests. Surfaces `riskLevel` (low/medium/high/critical), `affectedFiles`, `highFanInFiles`, `highFanOutFiles`, `ownershipGaps`, `testGaps`, `boundaryConcerns`, `policyConcerns`, `recommendedReviewCommands`, `humanApprovalRequired`. MCP `get_task_risk_report`.
- **Task risk in orchestration / brief / handoff** — `shrk orchestrate "<task>" --risk-aware` now computes both global and per-task risk; high/critical task risk injects the `risk-review` phase. Briefs attach `taskRisk` when a task is supplied. Handoffs include a `taskRiskSummary` block.
- **Task-aware role views** — `shrk view <role> --task "<task>"` returns a personalised top-command list, task-specific risks, "what not to do" and "human approval points". Supports developer/reviewer/architect/release-manager/security/ai-agent. MCP `get_role_view` accepts `task?: string`.
- **Tsconfig path-aware intelligence graph** — `shrk intelligence graph|stats|query --resolve-aliases` resolves `@shrkcrft/...` (and any other tsconfig path alias) to file edges. Edges include `resolvedVia: 'literal' | 'tsconfig-path'`; truncation block surfaces `aliasResolvedEdges`. MCP `query_repository_intelligence` accepts `resolveAliases?: boolean`.
- **Intelligence query DSL v2** — `shrk intelligence query "<expr>"` accepts `AND` (implicit, space), `OR` (literal), `not:<filter>`. Examples: `kind:package OR kind:test`, `kind:file not:tag:test`. `--explain` prints the parsed expression.
- **Architecture violations diff** — `shrk architecture violations [--since <ref>] [--staged] [--files a,b,c] [--baseline <json>] [--format text|markdown|html|json]`. Classifies each violation as `existing-touched` / `new-in-changed-file` / `resolved` / `unknown`. MCP `get_architecture_violations_diff`.
- **Compliance evidence v2** — `shrk compliance evidence <profileId> [--zip] [--sign] [--verify <dir|manifest>]`. Manifest now includes per-file SHA-256 + SharkCraft version + git commit (when available). `--sign` adds an HMAC-SHA256 signature via `SHARKCRAFT_EVIDENCE_SECRET`. `--zip` produces a `.tar.gz` when `tar` is available locally and gracefully degrades otherwise. `--verify` checks file hashes and the signature (when set).
- **Policy override audit auto-record** — `shrk policy run --record-override-audit` appends the applied overrides to `.sharkcraft/policy-override-audit.log` (only when there is at least one applied override). `shrk policy overrides audit --format text|markdown|json`.
- **Reposet doctor real signals** — `shrk reposet map [--parallel]` / `shrk reposet doctor` now populate per-repo `doctor.{ok,warnings,errors,info}`, `boundaryRules`, `policyOverrides`, `verificationCommands`, `templates`, `pipelines`, and `lastInspectionError` (when inspection fails).
- **Command taxonomy docs builder** — `shrk commands taxonomy --write-docs [--output docs/commands-taxonomy.md]` writes the live taxonomy as markdown. The product check now warns when the doc is absent.
- **Product check v2** — `shrk product check [--strict]` adds: CHANGELOG has a current or Unreleased entry; README links release notes / limitations / external quickstart; release notes carry a "not production stable" disclaimer; `docs/commands-taxonomy.md` is present when expected. `--strict` converts warnings to errors. `shrk release readiness --with-product-check` folds the report into readiness.
- **API report public surface diff** — `shrk api report --snapshot <file>` compares against a prior report; `--write-snapshot <file>` captures one. `shrk api diff <old> <new>` for an explicit diff. Output includes added/removed exports, metadata changes, and breaking-change suspects.
- **Pack quality delta** — `shrk packs quality <path> --snapshot|--write-snapshot` and `shrk packs quality-diff <old> <new>` for score / dimension / signature deltas.
- **Dashboard export delta** — `shrk dashboard export --compare-with <oldDir>` and `shrk dashboard diff <oldDir> <newDir>`. Compares packs / commands / graph nodes / graph edges / architecture risks / boundary violations + per-section byte sizes. No server, no upload.
- New MCP tools: `get_task_risk_report`, `get_architecture_violations_diff` (in addition to the R19 `get_role_view` augmentation).

### Changed

- `IRepositoryEdge` adds optional `resolvedVia` (`'literal' | 'tsconfig-path'`); set only on imports edges. Truncation block adds `aliasResolvedEdges`.
- `IRepoSetMapEntry` adds `boundaryRules / policyOverrides / verificationCommands / templates / pipelines / lastInspectionError` and a richer `doctor.info` count.
- `IAgentOrchestrationPlan` adds optional `taskRisk` (per-task ITaskRiskReport when riskAware).
- `IAgentBrief` adds optional `taskRisk` when a task is supplied.
- `IAgentHandoffReport` adds optional `taskRiskSummary`.
- `IProductCoherenceReport` adds `strict: boolean`.

### Safety

- All new MCP tools are read-only.
- Compliance evidence writes only into the supplied output directory; `--sign` requires an explicit secret, `--verify` is read-only.
- Policy override audit only writes when explicitly requested (`--record-override-audit`); the `audit` subcommand is read-only.
- Dashboard diff does not start a server.

## [Unreleased] — intelligence quality + risk-aware coherence (R19)

### Added

- **Repository intelligence graph v3** — `shrk intelligence graph --include-imports` adds real `imports` / `depends-on` / `tests` edges by feeding `scanImports` and the workspace package map into the graph. Edge-kind summary in `intelligence stats`. Truncation surfaces `importEdges` / `importEdgeCap` / `importEdgesCapped`.
- **Graph query lite** — `shrk intelligence query "<filters>"` with `kind:` / `edge:` / `imports:` / `depends-on:` / `text:` / `tag:` / `package:` / `construct:`. MCP `query_repository_intelligence`.
- **Architecture map v3** — `shrk architecture map --signals` runs the real boundary evaluator and folds the result + high-impact (fan-in / fan-out) into the map. New `shrk architecture violations` and `shrk architecture area <id>`. MCP `get_architecture_violations`, `get_architecture_area`.
- **Risk-aware orchestration** — `shrk orchestrate "<task>" --risk-aware` injects a `risk-review` phase before `plan` when boundary violations / unsigned packs / missing tests push risk to high/critical. Forbidden actions and review checkpoints adjust accordingly. MCP `create_agent_orchestration_plan` accepts `riskAware?: boolean`. New `get_risk_signals` MCP tool.
- **Compliance evidence packets** — `shrk compliance evidence <profileId> [--output <dir>]` writes the compliance report + folds in already-generated safety / release-readiness / packs / quality / smoke / self-audit JSON, plus a manifest. MCP `preview_compliance_evidence_packet`.
- **Policy override audit trail** — `shrk policy overrides` and `shrk policy overrides audit`. Append-only log at `.sharkcraft/policy-override-audit.log` (only written when explicitly invoked). MCP `get_policy_override_audit`.
- **Reposet parallel inspection** — `shrk reposet map --parallel [--concurrency N]` (default 4); order preserved deterministically; per-repo errors captured.
- **Golden output autopopulation** — `shrk examples golden --init` writes missing snapshots only; `--update` rewrites all; `--check` fails on missing/mismatch.
- **Command taxonomy** — `shrk commands taxonomy [--format text|markdown|json]` groups the catalog into Start here / Daily development / AI agent context / Review and impact / Architecture intelligence / Governance and compliance / Packs and ecosystem / CI and reports / Release readiness / Diagnostics and troubleshooting / Advanced. MCP `get_command_taxonomy`.
- **Product coherence check** — `shrk product check` verifies the README narrative + required docs + no "autonomous write agent" claim + MCP read-only statement. MCP `get_product_coherence`.
- **API report improvements** — `shrk api report --all`, `--public-only`, `--format html`.

### Changed

- `architecture map` JSON shape now exposes `boundaryViolations` as `{ ruleId, file, importSpecifier, severity, line, message }[]` (was `string[]`) plus a `boundaryViolationCounts` block. **Schema bumped to `sharkcraft.architecture-map/v2`** (no rename — same id, richer payload; consumers that only read the old fields keep working). The text/markdown/html renderers were extended.

### Safety

- All new MCP tools are read-only.
- Policy override audit only writes when invoked explicitly.
- Compliance evidence writes only into the supplied output directory.

## [Unreleased] — next-level AI-operable repository tooling (R18)

### Added

- **Repository intelligence graph v2** (`shrk intelligence graph|node|path|explain|stats` + MCP `get_repository_intelligence_graph` / `_node` / `find_*_path` / `explain_*_node`). Unifies packages, files, constructs, templates, pipelines, presets, boundaries, packs, public-API surfaces, decisions.
- **Change intent model** (`shrk intent "<task>"` + MCP `classify_change_intent`). Deterministic kind/domains/likelyConstructs classifier with risk hints + suggested first command.
- **Agent orchestration planner** (`shrk orchestrate "<task>" --mode conservative|balanced|aggressive` + MCP `create_agent_orchestration_plan`). Read-only multi-phase plan with forbidden actions + review checkpoints.
- **Safe workflow simulation** (`shrk simulate "<task>" --playbook|--pipeline` + MCP `simulate_workflow`). Predicts what a workflow would do without executing anything.
- **Architecture map v2** (`shrk architecture map --include layers,constructs,boundaries,public-api,tests,ownership --risk` + MCP `get_architecture_map`). Layered + risk-aware on top of the intelligence graph.
- **Decision / ADR support** (`shrk decisions list|get|new|report` + MCP `list_decisions`, `get_decision`, `preview_decision_draft`). Dry-run drafts; only writes under `sharkcraft/decisions/` with `--write-draft`.
- **Compliance profiles** (`shrk compliance profiles|get|check|report` + MCP `list_compliance_profiles`, `run_compliance_check`). Built-in `ai-safe-development`, `signed-pack-workflow`, `review-gated-codegen`, `ci-governed-repository`.
- **Policy severity overrides**: `policyOverrides` field in `sharkcraft.config.ts` (`severity` / `enabled` / `reason`) folded into existing policy reports.
- **Pack quality + docs** (`shrk packs quality <path>` + `shrk packs docs <path>` + MCP `get_pack_quality_report`, `get_pack_docs_preview`).
- **Reposet (multi-repo)** (`shrk reposet init|list|doctor|map` + MCP `list_reposet`, `get_reposet_map`). Read-only across multiple local repository roots.
- **Role views** (`shrk view developer|reviewer|architect|release-manager|security|ai-agent` + MCP `get_role_view`).
- **Command recommender** (`shrk recommend "<query>" [--from-error <stderr>] [--role <r>]` + MCP `recommend_commands`).
- **Diagnostics suggest** (`shrk diagnostics suggest "<stderr>" | --from-file` + MCP `suggest_diagnostic`).
- **Dashboard data export** (`shrk dashboard export --output .sharkcraft/dashboard-data --include repository-map,architecture,...` + MCP `get_dashboard_export_preview`).
- **Golden output snapshot tests** (`shrk examples golden [--update]`).
- **Release train model** (`shrk release train list|new|status|report|readiness`, registered under the `train` group). Local planning; no auto-publish/tag.
- **Upgrade advisor** (`shrk upgrade check|plan` + MCP `get_upgrade_advice`). Read-only schema-version detector.
- **Deep safety audit** (`shrk safety audit --deep` + MCP `get_safety_audit_deep`). Report-site external JS scan, demo destructive lines, CI workflow permissions.
- **Public API report** (`shrk api report [--package <name>] [--format text|markdown|json]` + MCP `get_package_api_report`).
- **Catalog**: 35+ new entries for the R18 surface; `commands doctor` and `commands ux-check` remain 0/0.

### Safety

- All new MCP tools are read-only.
- `decisions new`, `dashboard export`, `train new`, `reposet init` are dry-run by default and only write into draft/output directories.
- Pack-contributed verification commands are still NOT auto-run.

## [Unreleased] — public alpha finalisation (R17)

### Added

- **Release smoke content assertions** (`shrk release smoke --assertions` —
  on by default; `--no-assertions` opts out). Per-step
  `stdout-contains` / `stderr-not-contains` / `file-exists` /
  `file-contains` / `json-path-exists` / `output-not-empty` checks; a
  failing assertion marks the step failed.
- **Release smoke matrix mode** (`shrk release smoke --matrix
  [--target sharkcraft,dogfood,synthetic,consumer]`). Consumer target
  skipped with a warning when `--consumer-root` /
  `SHARKCRAFT_CONSUMER_ROOT` is unset.
- **Tarball install smoke** (`shrk install smoke --tarball`). Delegates to
  `bun run release:smoke-test` so the published-shape contract stays
  canonical.
- **Self-audit auto-population** (`shrk self audit --run [--timeout-ms <n>]`).
  Spawns the underlying checks with a per-step timeout.
- **Diagnostics registry** with `shrk diagnostics list / get <code>` and
  MCP tools `get_diagnostic_for_code` + `list_diagnostics`.
- **Pack-compat report-site embed**: `shrk report site --pack-compat <json>`
  renders a `pack-compat.html` page (placeholder when the file is absent).
- **Commands UX consistency check** (`shrk commands ux-check`): audits
  descriptions, safety metadata, alias collisions, and primary catalog
  references.
- **Public alpha release notes** (`docs/releases/0.1.0-alpha.1.md`),
  **limitations** (`docs/public-alpha-limitations.md`), and a
  **public-alpha checklist** (`docs/public-alpha-checklist.md`).
- **External repo quickstart** (`docs/external-repo-quickstart.md`).
- **Dashboard summary fold-in**. `get_dashboard_summary` includes
  `releaseReadiness` and `releaseSmoke` (with `ageMs`) when local
  artifacts exist.

### Changed

- `release readiness --strict` now expects release notes, public alpha
  limitations, external quickstart, and `CHANGELOG.md` — missing entries
  become warnings (strict promotes to blocker).
- Preflight summaries older than `PREFLIGHT_STALE_AFTER_DAYS = 7` are
  flagged as a warning even when `passed: true`.

### Safety

- All new MCP tools are read-only.
- `release smoke --matrix` writes only into the per-scenario temp
  fixture or the user-supplied `--temp-dir`. The consumer target uses
  the consumer's own working tree but never touches files outside
  SharkCraft pack/config/session/baseline assets.

## [0.1.0-alpha.1] — 2026-05-12

### Positioning

SharkCraft makes repositories understandable and safer for AI coding
agents. It does **not** replace Claude Code, Cursor, Aider, or any other
agent — it stores your project's rules, paths, templates, workflows, and
knowledge in a typed format and serves only the relevant slice to agents
through MCP and to humans through a CLI.

### Status

**Alpha.** APIs may shift between alpha tags. Bun ≥ 1.1 is the primary
runtime. Pin exact versions in lockfiles; expect a few breaking changes
before `0.1.0`.

### What is included

- 18 packages under `@shrkcrft/*` published to npm.
- A working CLI binary (`shrk`).
- An MCP server with ~34 tools and read-only resources.
- A pack system (third-party knowledge packages) with discovery, signing,
  verification, and a doctor.
- An export system for compatibility files (AGENTS.md, CLAUDE.md, Cursor
  rules, Copilot instructions).
- An import system for the same formats (drafts only).
- Pipelines: declarative agent workflows that render as shell scripts.
- A dogfood example repo and a representative consumer pack snapshot.

### Safety model (unchanged from the design intent)

- **MCP is read-only.** No tool in the MCP surface writes files.
- **The CLI is the only write path.** `shrk apply` writes plans; `shrk gen
  --write` writes generators.
- **Generation is plan-first.** Dry-run by default. Paths are refused if
  they escape the project root.
- **Plan signing.** HMAC-SHA256 over canonical JSON with
  `SHARKCRAFT_PLAN_SECRET`. Tampering is detected on `shrk apply
  --verify-signature`.
- **Pack signing.** Same model for pack manifests via
  `SHARKCRAFT_PACK_SECRET`. Signed JSON manifests are loaded as data, not
  code.
- **Knowledge files are trusted local TS config.** Same trust model as
  `vite.config.ts` / `eslint.config.js`. Only install packs you trust.

### CLI highlights

- `shrk init` — scaffold a `sharkcraft/` folder.
- `shrk inspect` / `shrk doctor` — workspace and readiness inspection.
- `shrk doctor --strict[=errors|warnings|all] --min-score N` — CI gate.
- `shrk context --task "..."` — token-budgeted, filtered context for a task.
- `shrk rules relevant --task "..."` — only the matching rules.
- `shrk gen <template> <name> --dry-run --save-plan ...` — plan-first
  generation.
- `shrk apply <plan> [--verify-signature]` — single write path.
- `shrk export agents-md|claude-md|cursor-rules|copilot-instructions`
  — compatibility-file exports.
- `shrk import agents-md|claude-md|cursor-rules` — parse external files
  into draft knowledge modules (`sharkcraft/imports/<format>.draft.ts`).
- `shrk pipelines list|get|context|plan|script|next` — declarative
  workflows. `shrk pipeline` is an alias.
- `shrk packs list|get|inspect|doctor|sign|verify` — third-party pack
  management. `shrk pack` is an alias.
- `shrk mcp serve [--http] [--watch]` — start the MCP server (stdio or
  Streamable HTTP).

### MCP highlights

- ~34 tools across project overview, knowledge, rules, paths, templates,
  pipelines, packs, action hints, AI-readiness, and read-only resources.
- Built on `@modelcontextprotocol/sdk` (stdio + Streamable HTTP).
- Zod-validated input on every tool call.
- `notifications/resources/list_changed` fires when `--watch` is set and
  knowledge / templates / pipelines change on disk.
- **The MCP server never writes files** — `create_generation_plan` returns
  a dry-run plan that the human applies via the CLI.

### Pack system

- Discovery walks `node_modules/` for packages with a `sharkcraft` field
  in `package.json`. Manifests can be TypeScript modules
  (`./src/sharkcraft.plugin.ts`) or signed JSON
  (`./src/sharkcraft.plugin.signed.json`).
- Signed JSON manifests are read as data — never dynamic-imported.
- `shrk packs sign <manifest-or-folder> --key-id … --verify-after-sign`.
- `shrk packs verify [--required]` — fails on tampered or unsigned packs.
- `shrk packs doctor [--verify-signatures] [--require-signatures]` —
  invalid manifests, missing files, empty contributions, duplicate ids,
  template/pipeline quality, hint coverage, signature status.
- Resolved counts: every pack reports both declared contribution-file
  counts AND resolved object counts after dedup.
- Local entries always win on duplicate ids; pack contributions are
  reported as info/warning issues.

### Pipelines

- Declarative pipeline definitions live in `sharkcraft/pipelines.ts`.
- `shrk pipelines script <id> --task "..." --var k=v` renders a literal
  bash script the agent or a human can run line by line.
- Apply/write steps include a manual-confirm prompt.

### Import / export

- Imports always land as drafts under `sharkcraft/imports/`. Library APIs
  never write files.
- Exports default to dry-run preview; `--write` saves to a sensible
  default location.

### Known limitations

- Token estimator is a heuristic; the v0.2 plan is to swap in a real
  tokenizer.
- `bunx @shrkcrft/cli@alpha` works once `@shrkcrft/cli@0.1.0-alpha.1`
  is published; until then, use the local repo via `bun run shrk`.
- npm publishing requires `bump-versions` to write concrete `^x.y.z` pins
  in place of `workspace:*` — `publish-dry-run` and `install-smoke-test`
  already swap these in-flight, but the on-disk `package.json` keeps the
  dev `workspace:*` pin until a publishing run.
- The CLI ships a `shrk` bin; the MCP server is a library invoked via
  `shrk mcp serve` (no separate binary in alpha).
- Pack discovery scans `node_modules/` only; pnpm-style nested hoisting
  may not be picked up everywhere.

### Install / upgrade

```bash
# Once published (this is the alpha-1 form):
npm install -g @shrkcrft/cli@0.1.0-alpha.1
shrk --version  # → SharkCraft v0.1.0-alpha.1

# Quick try without a global install:
bunx @shrkcrft/cli@alpha init
bunx @shrkcrft/cli@alpha doctor
```

### Repo metadata

- 18 packages
- 190 tests across 34 files
- Typecheck green, build:dist green, publish-dry-run green,
  release-preflight green
- Dogfood readiness: 71 / 100 (good)
- Consumer readiness: 87 / 100 (excellent)
