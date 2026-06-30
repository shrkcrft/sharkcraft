# Safety model

SharkCraft is designed so that AI agents can operate confidently without
risking damage to the project. The model has four pillars.

## 1. The CLI is the only write path

`shrk apply` is the only command that writes source files. MCP tools are
read-only — every MCP tool returns a `nextCommand` hint when an action
would mutate state, and the human runs the CLI to perform it.

## 2. Plans are signable and reproducible

`shrk gen --save-plan` produces a `sharkcraft.plan/v1` JSON file. The plan
captures: the template, the variables, and every file that would be
written. Sign with `shrk gen --sign` (or set `SHARKCRAFT_PLAN_SECRET`) and
later verify with `shrk apply --verify-signature`.

`shrk apply` refuses to run if:

- the live plan diverges from the saved one (unless `--allow-divergent`)
- the live plan contains file conflicts
- the signature is required and missing/invalid

## 3. Verification commands are explicit

`shrk apply --validate` only runs verification commands that you have
explicitly listed in `sharkcraft/sharkcraft.config.ts verificationCommands[]`.
Pack-contributed commands are surfaced for review but never auto-run.

## 4. Dev sessions are local and auditable

Every multi-step run lives under `.sharkcraft/sessions/<id>/`. The
session.json schema captures: phase, plans, applied plans (with signature
+ divergence status), validations, reports, next action. `shrk dev report`
turns it into a Markdown audit trail.

## 5. R47 — imported check results land under `.sharkcraft/checks/`

`shrk checks import <file>` is the only command introduced in R47 that
writes to disk. It writes a single timestamped JSON file under
`.sharkcraft/checks/` (the canonical `sharkcraft.check-result/v1`
shape) and nothing else.

- The CLI never executes the third-party tool on import. The user
  runs ESLint / Biome / Jest themselves and points `shrk checks
  import` at the resulting JSON.
- The aggregate is purely a roll-up — `shrk checks aggregate` reads
  the directory and writes `aggregate.json` next to the inputs.
- No new MCP write tool was added in R47. The protocol surfaces are
  CLI-only.
- `shrk checks convert eslint|biome` defaults to stdout. It writes
  to disk only when explicitly given `--output <path>` or `--store`.

## Safety labels

Every CLI command carries a safety label:

| Label              | Examples                                           |
|--------------------|----------------------------------------------------|
| `read-only`        | `doctor`, `context`, `task`, `graph`, `coverage`   |
| `writes-session`   | `dev start`, `dev plan`, `dev mark-applied`        |
| `writes-drafts`    | `onboard --write-drafts`, `onboard adopt --write-patch`, `boundaries infer --write-drafts`, `ingest repository --write-drafts`, `ingest adopt --write-patch`, `ingest adopt plan` (R28 adds `--include-body`), `generated protect --write-drafts`, `languages cache clear --write`, `plugin rename --output`, `plugin remove --output`, `helper plan --output`, `doctor suppress` (R29 writes `sharkcraft/doctor.suppressions.json`), `knowledge rename-symbol --write` / `rename-file --write` / `update-anchor --write` (R29 writes under `sharkcraft/knowledge-updates/`), `feedback convert-to-backlog --output` (R29 writes a backlog markdown), **R44** `knowledge add --write-preview` / `knowledge update --write-preview` / `knowledge remove --write-preview` / `knowledge lint --write-preview` (writes drafts + manifest + explainer under `.sharkcraft/authoring/` or `.sharkcraft/fixes/`), `pack author pending --write-todo` (writes `.sharkcraft/reports/pack-signing-todo.md`) |
| `writes-source`    | `apply`, `gen --write`, `init`, `packs sign`, `packs new --write` |
| `runs-shell`       | `dev validate`, `apply --validate`                 |
| `requires-review`  | Anything in the above three that needs a human    |

See `shrk commands` for the full inventory, or `get_command_catalog` over
MCP.

## What MCP never does

- Never writes a file
- Never executes a shell command
- Never publishes
- Never installs a pack
- Never auto-applies a plan
- Never modifies session.json
- Never runs an AI model
- Never executes ingestion drafts or adoption patches — R26's
  `create_repository_ingestion_plan` / `get_repository_knowledge_model` /
  `understand_task` / `validate_change_context` / `get_contradiction_report` /
  `get_generated_code_report` / `get_stability_map` / `get_ingest_adoption_preview`
  all return data + a next-command hint. The human runs `shrk ingest …` to
  materialise.
- Never executes language commands or applies an ingest adoption plan —
  R27's `get_polyglot_boundary_report` / `get_language_run_plan` /
  `get_language_cache_status` / `get_language_profiles_live` all return
  data + a next-command hint. The human runs `shrk languages run
  --execute` or `shrk onboard adopt --write-patch` from the CLI (R48
  collapsed the parallel `ingest adopt` apply path into `onboard adopt`).
- Never renames or removes plugins, applies helper plans, or signs packs.
  R28's `get_changed_boundary_report` / `preview_plugin_rename` /
  `preview_plugin_remove` / `list_helpers` / `get_helper` /
  `preview_helper_plan` / `get_pack_dev_status` / `preview_pack_tests` /
  `get_registry_lifecycle_report` / `get_language_runner_policy` all
  return data + a next-command hint. The destructive lifecycle plans
  require explicit human approval and CLI-applied signature verification.
  `shrk packs watch` runs shell commands but never auto-signs.
- Never updates suppressions, rewrites knowledge entries, or executes
  feedback actions. R29's `get_doctor_suppressions` /
  `get_doctor_filtered_report` / `get_knowledge_stale_report` /
  `get_knowledge_references` / `preview_knowledge_rename` /
  `get_template_drift_report` / `resolve_query` / `trace_query` /
  `preview_feedback_actions` are read-only. The corresponding CLI
  helpers write only inside `sharkcraft/` (suppressions config or
  knowledge-update patches).
- Never resolves an impact target, lists feedback rules, or surfaces
  decisions in a way that mutates state. R30's `get_fuzzy_impact_report`
  / `list_feedback_rules` / `get_feedback_rule` / `get_decisions_report`
  return data + a next-command hint. The CLI is still the only entry
  point that runs the impact engine or writes a decision draft.

## Safety audit

`shrk safety audit [--json]` produces a deterministic safety audit:

- every CLI command grouped by safety level
- the MCP tool list with `canWrite` (always false)
- verification commands: trusted local / pack-contributed / untrusted local
- pack signature status (verified / not-checked / unsigned / invalid)
- plan-signing secret status
- recommendations (e.g. unsigned packs, untrusted verifications)

The same audit is exposed read-only via the MCP tool `get_safety_audit`.

Exit code is non-zero if and only if the MCP read-only invariant is
violated (i.e. some tool reports `canWrite=true`) — so you can wire it
into CI as a tripwire.

`shrk safety audit --deep` runs the same audit plus a deeper scan for
external JavaScript in the report site, destructive lines in demo
scripts, and over-permissive CI workflow tokens.

## Per-task risk (R20)

`shrk risk "<task>"` computes a deterministic per-task risk report from:

- change intent (kind / domain / required-review)
- impact analysis (direct + transitive dependents, boundary impact,
  ownership impact, missing tests)
- architecture map signals (high fan-in / fan-out files)
- global state (current boundary violation counts, no-tests-in-repo)

Output includes `riskLevel` (low/medium/high/critical), `reasons[]`,
`humanApprovalRequired`, recommended-review commands, and the affected
files/constructs/policies/ownership gaps. `shrk orchestrate --risk-aware`
folds the per-task risk into the plan; high/critical risk injects a
`risk-review` phase that requires explicit human approval before the
plan phase. Reachable via the MCP tool `get_task_risk_report` — read-only.

## Contract gates + apply gate (R24, opt-in)

R23's agent contract is now actionable via opt-in gates:

- `shrk contract check <c> [--plan <p>] [--approval <a>]` returns pass/fail.
- `shrk contract approve <c> --by <name> --reason "<text>" --output <file>`
  signs an approval (HMAC when `SHARKCRAFT_CONTRACT_SECRET` is set).
- `shrk apply <plan> --contract <c> --approval <a>` runs the gate check
  before writing. **Opt-in**: the pre-R24 `shrk apply <plan>` is unchanged.

MCP additions (R24, all read-only):
- `get_contract_status` — validate a contract.
- `create_contract_approval_preview` — preview only; never persists.
- `query_execution_graph` — query a saved or rebuilt execution graph.

## Polyglot support (advisory)

Language detection / command inference / dependency scanning /
test impact for Java, C#, Python, Go, Rust. Everything is advisory and
read-only. The only write paths affected:

- `shrk ci scaffold --polyglot` writes a workflow YAML when `--write` is set (same as the pre-R25 scaffold).
- `shrk memory build --write-snapshot` archives the index under `.sharkcraft/memory/history/`.

No new MCP write tools. The polyglot dependency scanner uses regex only;
no compiler / AST integration.

## Memory-weighted risk (R24)

`shrk risk --include-memory` (and all callers via `--include-memory`) now
actually moves the score. Hard invariants: memory cannot lower base risk;
adjustment is capped at 14; stale index (>30 days) halves the adjustment;
missing index reports it explicitly.

## Agent contract / plan simulation / repo memory (R23)

R23 added five capabilities; all obey the existing safety pledges. Three
remain CLI commands:

- `shrk contract "<task>"` — read-only; `--save` writes only under
  `.sharkcraft/contracts/`. MCP tool `create_agent_contract` is read-only.
- `shrk plan simulate <plan.json>` — read-only; no source writes; MCP
  tool `simulate_plan` is read-only.
- `shrk memory build|report|risk|files|diagnostics|reset` — local-only
  (no network, no telemetry, no embeddings). Writes only into
  `.sharkcraft/memory/`. `memory reset --write` refuses to step outside
  that directory. MCP tools are read-only.

### Healing plans + execution graph (CLI verbs retired — MCP-only)

The other two R23 capabilities lost their CLI verbs but keep their
read-only MCP surfaces. They never auto-fix, never write source, never
execute:

- Healing plans — the former `shrk heal …` CLI verb was removed. Surviving
  surface: MCP tool `create_healing_plan` (read-only). See
  [`healing-plans.md`](./healing-plans.md).
- Task execution graph — the former `shrk agent graph "<task>"` CLI verb
  was removed. Surviving surfaces: MCP tools `create_execution_graph` and
  `query_execution_graph` (read-only). See
  [`execution-graph.md`](./execution-graph.md).

## Compliance evidence packets (retired by R46)

The R19/R20 `shrk compliance evidence` / `shrk compliance check` CLI and
the matching MCP tools (`list_compliance_profiles`,
`get_compliance_profile`, `run_compliance_check`,
`preview_compliance_evidence_packet`) were retired in R46. SharkCraft is
local-first dev governance, not an audit-evidence vendor. The canonical
replacement is `shrk safety audit --deep`, which already aggregates the
safety / readiness / packs / quality / smoke JSON the old packet pulled
together. If you need an evidence bundle, snapshot the safety-audit
output yourself — there is no longer a tool that claims a compliance
verdict.

## Catalog completeness

`shrk commands doctor [--json]` checks invariants against the live
command registry:

- every catalog entry has a description, category, and safety level
- writes-source commands are not marked `mcpAvailable`
- runs-shell entries have the corresponding flag
- every registered top-level command appears in the catalog (warning)
- every registered command has a non-empty usage string (warning)
- catalog has no duplicate commands (error)

## HTML reports

Every report renderer (`adoption`, `session`, `quality`, `safety`,
`review`, `coverage`, `drift`) writes self-contained HTML. The contract:

- inline CSS, no external assets
- no JavaScript except the tiny SSE bootstrap in `dev open --serve --live`
- escapes `<`, `>`, `&`, `"`, `'` in user-supplied strings
- dark-mode aware via `prefers-color-scheme`

This is why HTML output can safely be uploaded as a CI artifact or
attached to a ticket — the file is the entire deliverable.

## Live session server

`shrk dev open <id> --serve --live` runs a localhost-only HTTP server
that streams session changes via Server-Sent Events. The server:

- binds `127.0.0.1` by default; warns when `--host` is set to anything else
- accepts only `GET` and `HEAD` (every other verb returns `405`)
- has no write endpoints (no POST/PUT/DELETE)
- has no auth, no telemetry, no static asset serving
- watches `session.json`, `plans/`, and `reports/` with a debounce

## Dashboard

`shrk dashboard` serves the local read-only React/Vite dashboard plus the
versioned dashboard API (`sharkcraft.dashboard-api/v1`). It inherits every
guarantee of the live session server **plus**:

- `/api/health.readOnly === true`, always.
- `/api/capabilities.writeEndpoints === []`, always.
- Every page renders dangerous actions as **copyable** `<CommandBlock>` —
  the user runs them in their own shell. There are no Apply / Run / Execute
  buttons anywhere in the UI.
- The session HTML report is served at `/api/sessions/:id/report.html` with
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  img-src data:; base-uri 'none'; form-action 'none'` and embedded in
  `<iframe sandbox="">` — no scripts, no navigation, no parent access.
- SSE (`/api/sessions/:id/events`) emits filesystem-change notifications
  only; it cannot accept any input.

These invariants are exercised end-to-end by `e2e/20-read-only-safety.e2e.ts`:
POST/PUT/PATCH/DELETE → 405 on three routes, `readOnly: true` on health,
`writeEndpoints: []` on capabilities, and no forbidden button labels (`Apply
now`, `Run command`, `Execute`, `Run plan`, `Apply plan`) exist on any of
six representative routes. See `docs/dashboard.md` and `docs/testing.md`
for the full E2E surface.

## R44 — authoring loop, preview-first

R44 added knowledge / pack-asset authoring previews. The same safety
contract applies:

- `shrk knowledge add | update | remove | lint` are preview-only by
  default. Their `--write-preview` flag writes drafts only under
  `.sharkcraft/authoring/` (knowledge drafts) or `.sharkcraft/fixes/`
  (lint output). They never mutate `sharkcraft/knowledge.ts` and never
  touch pack source.
- `shrk pack author pending --write-todo` writes a signing TODO under
  `.sharkcraft/reports/pack-signing-todo.md` when
  `SHARKCRAFT_PACK_SECRET` is missing. It never signs.
- `.sharkcraft/asset-provenance.jsonl` is local-only, append-only.
  No network calls, no telemetry. See [`asset-provenance.md`](./asset-provenance.md).
- No new MCP write tools. The R44 inspector modules (`knowledge-authoring.ts`,
  `knowledge-lint.ts`, `pack-author.ts`, `asset-provenance.ts`,
  `pack-pending.ts`) are pure builders + a single local file appender.
- The pack signature is **deliberately allowed to go stale** when a pack
  asset is authored. The pending view reports the staleness honestly
  and prints the exact `SHARKCRAFT_PACK_SECRET=… shrk packs sign …`
  command for the human or signing CI to run.

## R51 — bounded loader, preserved invariants

R51 added bounded TS asset loading and a persistent inspector cache.
None of it changes the safety pledges:

- **MCP stays read-only.** `inspectSharkcraft({useCache})` defaults to
  `false`, so MCP tools that call the inspector never trigger cache
  writes. The MCP `quality-safety` E2E asserts `readdirSync(root)` is
  unchanged after every read-only tool call.
- **No fake-signing.** Loader failure does not bypass signature
  verification; the doctor still red-flags pack signature staleness.
- **No silent loader failures.** A previously-failed pack asset is
  reported as a doctor error every run, plus a `cached-skip` entry
  in `loaderDiagnostics`. The pack is not silently treated as empty.
- **Cache stores metadata only.** No module bodies, no eval results,
  no secrets — just `{filePath, mtimeMs, sizeBytes, contentHashPrefix,
  status, elapsedMs, kind, ids[], warningCount, errorMessage}`. Safe
  to delete at any time (`rm -rf .sharkcraft/cache`).
- **`--no-cache` bypass** keeps the cache from short-circuiting
  anything when an operator wants a clean read.
- **The bounded loader does not increase write surface.** Loaders
  still take a single path and return data; no new "apply"
  capability landed.

## R52 — authoring symmetry, preserved invariants

R52 added authoring parity (`shrk rules add|remove`, `shrk templates
update|remove`), an in-place `shrk fix --action-hints --apply`, the
`shrk doctor --blockers` triage preset, a pack signing release-handoff
gate, and a dev-signature line in `safety audit --deep`. None of it
changes the safety pledges:

- **MCP stays read-only.** No new MCP write tools were added in R52.
  The action-hint apply lives on the CLI only — the splicer is in
  `packages/cli/src/asset-preview/apply-action-hint-stub.ts` and is
  not surfaced as an MCP tool.
- **`--apply` is preview-first.** `shrk fix --action-hints --apply`
  computes every patch via `applyActionHintStub({write:false})` for
  every target first, refuses on divergence unless `--allow-divergent`
  is set, and only then runs the same splicer with `write:true`.
  Refused targets block the entire apply when `--allow-divergent` is
  off.
- **No pack-source mutation.** The action-hint apply refuses any
  entry whose `source.origin` lives under `node_modules/` or
  `dist/`. Pack edits still require editing the pack source and
  re-signing the manifest (see
  [pack-signatures.md](./pack-signatures.md)).
- **No fake-signing.** R52 never auto-re-signs. Dev signatures
  (`shrk packs sign --dev`) stay distinct from release signatures, and
  `shrk release readiness` fails closed instead of laundering a dev
  signature into a release one.
- **Provenance is recorded for every write path.** Every
  `--write-preview` and `--apply` invocation appends a
  `sharkcraft.asset-provenance/v1` entry to
  `.sharkcraft/asset-provenance.jsonl`.
- **`shrk doctor --blockers` is a visibility preset, not an
  authorisation one.** It only changes which findings print + the
  exit code. It does not change what the engine considers a violation,
  and it cannot suppress an error.
