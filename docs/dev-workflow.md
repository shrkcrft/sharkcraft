# Dev workflow

`shrk dev` is the safe, deterministic AI-assisted development loop. It guides
a feature request from a one-line task all the way to an audit-trail report,
without ever writing source files, calling a model, or running an untrusted
command.

The flow:

```
shrk dev start "<task>"
        ↓
shrk dev plan <id> --template <id> --name <name> [--var k=v ...]
        ↓                 (auto-runs plan review on saved plans)
shrk apply <plan.json> --verify-signature      ← the human-approval step
        ↓  (session-aware: signature/divergence/conflicts persisted)
shrk dev validate <id>
        ↓
shrk dev report <id>
```

## Session-aware apply

When you run `shrk apply` against a plan that lives under
`.sharkcraft/sessions/<id>/plans/`, the CLI automatically updates the
session's `session.json` after a successful apply:

- adds an entry to `appliedPlans[]` with the changed files
- records the signature status (`verified` / `unsigned` / `invalid` / `not-checked`)
- records whether the live plan diverged from the saved plan
- promotes the plan entry to `applied`
- recomputes the session phase and `nextAction`

The same is true for `shrk apply <plan> --validate`: the validation report
lands under `<session>/reports/`, the session's `validations[]` array gets a
new entry, the phase is set to `validated` (or `validation_failed` on
failure), and `nextAction` is recomputed.

The rules are conservative — refused divergence, conflicts, dry-runs, and
failed apply runs leave the session metadata untouched. To attach a plan
that does not live under the session directory, pass `--session <id>`
explicitly.

## Repairing session metadata

If you ran the workflow manually (eg. via `shrk gen` + `shrk apply` without
a session), you can patch the session's metadata after the fact:

```bash
shrk dev mark-applied   <sessionId> <planFile> [--note "..."]
shrk dev mark-validated <sessionId> [--report path] [--status passed|failed] [--note "..."]
```

Both commands are metadata-only — they never write source files. They verify
that the session exists, that the plan file exists when provided, and they
recompute the phase + `nextAction`.

## Convenience commands

```bash
shrk dev open     <sessionId>   # print paths inside the session
shrk dev plans    <sessionId>   # list plans tracked in session.json
shrk dev reports  <sessionId>   # list reports under reports/
shrk dev commands <sessionId>   # print a copy-pasteable command list
shrk dev diff     <a> <b>       # diff two sessions (phase / plans / packet)
shrk dev list                   # list all sessions with phase + next action
shrk dev archive  <sessionId>   # move to .sharkcraft/sessions-archive/<id>
shrk dev clean --older-than 14d [--archive] [--write] [--include-active]
```

`dev clean` is **dry-run by default**. It never deletes active or
incomplete sessions unless you pass `--include-active` explicitly.

## HTML report

```bash
shrk dev report <id> --html                  # writes final-report.html
shrk dev open   <id> --html                  # writes final-report.html only
shrk dev open   <id> --serve --port 8765     # localhost-only HTTP server
shrk dev open   <id> --serve --live          # SSE + auto-refresh
shrk dev open   <id> --serve --live --open   # also open the URL (macOS)
shrk dev open   <id> --serve --live --port 0 # random free port
```

See [`docs/session-html-report.md`](session-html-report.md) for details.
The server binds to `127.0.0.1` by default; pass `--host` explicitly to
expose it elsewhere — the CLI prints a warning when you do.

With `--live` the server exposes a `GET /events` Server-Sent Events
endpoint and the rendered HTML includes a tiny script that reloads the
page on every `change` event. A `<meta http-equiv="refresh" content="30">`
fallback keeps things working even when SSE isn't supported by the
browser. The server watches `session.json`, `plans/`, and `reports/` and
debounces changes (≈200ms).

Only `GET` / `HEAD` are accepted — every other verb returns `405`. There
are no write endpoints. No POST. No PUT. No DELETE.

The local **dashboard** (`shrk dashboard`) exposes the same session data
under `/api/sessions` and `/api/sessions/:id`, plus a live SSE feed at
`/api/sessions/:id/events` and a sandboxed HTML report at
`/api/sessions/:id/report.html`. The session detail page in the UI
auto-refreshes on SSE events and inlines the HTML report in an
`<iframe sandbox="">`. See [`docs/dashboard.md`](dashboard.md).

Every step writes only inside `.sharkcraft/sessions/<id>/`. MCP exposes a
read-only view of the same data; MCP never creates a session.

## Commands

```bash
shrk dev start "<task>"        # build task packet → create session → output next command
shrk dev "<task>"              # alias for `dev start`
shrk dev plan <id> [opts]      # generate dry-run plans (or intents) under plans/
shrk dev status <id>           # current phase, plans, validations, next action
shrk dev next <id>             # compute the next safe command (also: continue)
shrk dev validate <id>         # run configured verifications + boundary check + report
shrk dev report <id>           # write final-report.md
shrk dev list                  # list all dev sessions
```

All commands accept `--cwd <dir>` and `--json` where useful.

## Session phases

A `session.json` (schema `sharkcraft.dev-session/v1`) tracks every session's
current state machine:

| Phase | Set by |
|---|---|
| `started` | `shrk dev start` |
| `planned` | `shrk dev plan` saves at least one plan |
| `reviewed` | `shrk dev plan` auto-runs plan review on the saved plan |
| `applied` | `shrk dev validate` (inferred — apply is the explicit human step) |
| `validated` | `shrk dev validate` exits 0 |
| `completed` | `shrk dev report` |

`shrk dev next` reads filesystem + `session.json` and prints the safe next
command for whichever phase you're in. Sessions written by the legacy
`shrk session start` command (removed in R48 — `dev start` is canonical)
are still readable — `dev status` shows them as `(legacy)` and still
computes a next-action recommendation from the filesystem.

## Session layout

```
.sharkcraft/sessions/<id>/
├── task.md                       # raw task line
├── task-packet.json              # buildTaskPacket() snapshot
├── context.md                    # rendered context body
├── action-hints.json             # aggregated action hints
├── recommended-pipeline.json     # selected pipeline + alternatives
├── next-steps.md                 # human-readable walkthrough
├── commands.sh                   # suggested CLI commands (read before running)
├── session.json                  # state machine (see schema above)
├── plans/
│   ├── <plan-name>.json          # signed if SHARKCRAFT_PLAN_SECRET is set
│   └── <template-id>.intent.md   # written when required variables are missing
├── reports/
│   ├── plan-review-<plan-name>.json
│   ├── plan-review-<plan-name>.md
│   └── validate-<timestamp>.json
└── final-report.md               # produced by `shrk dev report`
```

## `dev start "<task>"`

Builds the task packet, picks a recommended pipeline + templates, and writes
the full bundle above (minus plans/reports, which are empty). Output:

```
=== Dev session started: 2026-05-12T...-create-a-user-profile-service ===
  task               create a user profile service
  pipeline           feature-dev
  top templates      typescript.service
  top rules          tests-required, name-pascal-case
Verification commands:
  $ bun test
  $ bun x tsc -p tsconfig.base.json --noEmit
Next: shrk dev plan 2026-05-12T...-create-a-user-profile-service
```

The "Next" line is the safe next CLI command. Run it.

## `dev plan <id>`

For each requested template:

- If required variables are present, run a dry-run generation, build a saved
  plan, sign it if `SHARKCRAFT_PLAN_SECRET` is set, save under
  `plans/<name>.json`, and run plan review into
  `reports/plan-review-<name>.{json,md}`.
- If required variables are missing, write `plans/<template-id>.intent.md`
  describing exactly what's needed — **never auto-fill variables**.

Flags:

```
--template <id>     # plan a specific template
--name <name>       # template's primary name argument (kebab-case)
--var key=value     # pass variables (repeatable)
--sign              # force-sign (default: sign when SHARKCRAFT_PLAN_SECRET is set)
--all               # plan the top 3 ranked templates
--json              # machine-readable output
```

Example:

```bash
shrk dev plan <id> \
  --template typescript.service \
  --name user-profile \
  --var className=UserProfileService
```

## `dev status <id>`

Single-screen view of where the session sits:

- task + phase + timestamps
- selected pipeline + top templates
- each plan (status, missing variables, review file)
- validations (pass/fail, command counts, boundary violations)
- applied plans
- next recommended command + reason + whether human approval is required

`--json` gives the same structure as a struct for tools.

## `dev next <id>` / `dev continue <id>`

Computes the next safe command without running it. Persists the computed
command back into `session.json.nextAction` so MCP clients see a fresh value
on every poll. Examples it produces:

| Situation | Output |
|---|---|
| No plans yet | `shrk dev plan <id>` |
| Intent file present, vars missing | `shrk dev plan <id> --template <id> --var <name>=<value>` |
| Saved plans, no reviews | `shrk dev plan <id>` (re-runs review) |
| Reviewed, not applied | `shrk apply <plans/...json> --verify-signature` (⚠ human approval) |
| Applied, not validated | `shrk dev validate <id>` |
| Validated | `shrk dev report <id>` |
| Completed | `shrk dev report <id>` |

## `dev validate <id>`

Runs the same validation loop as `shrk apply --validate` but scoped to a dev
session: results land under `reports/validate-<timestamp>.json` and the
validation is recorded in `session.json.validations[]`.

Flags:

```
--command "<shell>"       # explicit shell command (always trusted)
--verification <id>       # opt in to a single sharkcraft.config verificationCommands entry
--all-verifications       # opt in to every configured (and trusted) command
--boundaries / --coverage / --drift / --context-tests / --agent-tests
--strict                  # fail the run on warnings
--allow-pack-commands     # future: opt in to pack-contributed commands (currently inert)
--report / --json
```

Safety:

- **Pack-contributed verification commands are never auto-run.** Only
  `sharkcraft.config.ts verificationCommands[]` is trusted.
- Each command is printed before it runs (`→ running: ...`).
- Boundary violations surface as warnings (not failures) unless
  `--strict` is set.
- A failing validation does NOT roll back files — apply is its own step.

## `dev report <id>`

Renders `final-report.md` inside the session. Sections:

- task + phase
- timeline
- task packet summary
- selected pipeline + templates
- generated plans
- plan reviews
- applied plans
- validation results
- remaining risks
- next suggested actions

Marks the session `completed` and persists `final-report.md` in `reports[]`.

## MCP integration (read-only)

| Tool | What it does |
|---|---|
| `start_dev_session_preview` | Build the same task packet `dev start` would, but **do NOT** create a session. Returns the CLI command to run. |
| `get_dev_session` | Read one session's full state. |
| `get_dev_status` | High-level status: phase + counts + next action. |
| `get_dev_next_action` | Compute the safe next CLI command. |
| `get_dev_report` | Render `final-report.md` as a string **without writing it**. |
| `list_dev_sessions` | List session ids. |

MCP **never writes**. Even `start_dev_session_preview` returns
`{ cliCommand: "shrk dev start \"...\""\, note: ... }` — the human runs that
command to create the session.

## Safety summary

- No source files are modified by any `dev` command. Only artifacts under
  `.sharkcraft/sessions/<id>/`.
- Generation plans are dry-run only and signed if `SHARKCRAFT_PLAN_SECRET`
  is set.
- Plan application is **always** the explicit human step:
  `shrk apply <plan> --verify-signature`.
- Validate runs only commands from `sharkcraft.config.ts verificationCommands[]`
  (or an explicit `--command`). Pack-contributed commands require
  `--allow-pack-commands`.
- MCP is read-only by contract.
- Old `shrk session start` sessions (without `session.json`) remain readable.

## Blockers-only triage (R52)

When an agent arrives mid-session and only wants the must-fix list,
`shrk doctor --blockers` is the canonical entrypoint:

```bash
shrk doctor --blockers           # human view
shrk doctor --blockers --json    # agent view (stable shape)
shrk doctor --blockers --watch   # re-render on every sharkcraft/ change
```

A finding is a blocker when:

- `severity = error`, OR
- `severity = warning` AND category ∈ `{config-invalid,
  pack-signature-invalid, plan-signature-divergent, asset-load-failed}`.

Everything else (`action-hint-quality`, advisory rules, suppressed
"known noise") is **not** a blocker. The exit code is the contract:
0 means no must-fix work remains; 1 means at least one blocker stays.

See [`docs/doctor.md`](./doctor.md) for the full definition.

## Action-hint stubs apply path (R52)

`shrk fix --action-hints --apply` splices stubbed `actionHints: { ... }`
blocks into the matching knowledge entries in `sharkcraft/knowledge.ts`,
replacing the previous "preview-only into `.sharkcraft/fixes/`, then
hand-edit" flow. Constraints:

- Preview-first under the hood — the command computes the patch, refuses
  on divergence (existing `actionHints` field) unless `--allow-divergent`
  is passed, then writes.
- Refuses pack-contributed entries by default (their source lives in the
  pack package; editing requires re-signing).
- Stubs are commented `TODO` placeholders. The
  `missing-action-hints` warning flips off; doctor's
  `action-hint-quality` warning takes over until placeholders are
  filled.
- Records provenance per applied stub (`assetKind=Knowledge`,
  `operation=Update`, `extra.fixKind='action-hints'`).

## Apply parity (R53 / R54)

R53 extended `--apply` to two more fix kinds and one authoring verb;
R54 upgraded knowledge-stale apply to rename-in-place and added
missing-barrel auto-create:

```bash
# R52 — action-hint stubs
shrk fix --action-hints --apply [--allow-divergent]

# R54 — knowledge-stale: rename when engine identifies the new location,
# drop only with explicit flag otherwise.
shrk fix --knowledge-stale --apply                     # rename-in-place (default; safe)
shrk fix --knowledge-stale --apply --drop-stale        # also drop unrenameable stale refs
shrk fix --knowledge-stale --apply --drop-missing      # also drop unrenameable missing refs

# R53 — drop unresolved related ids from templates in place
# R54 — also create missing barrel files (placeholder body) in one pass.
shrk fix --template-drift --apply

# R53 — splice metadata updates into an existing template literal in place
shrk templates update <id> [--name ...] [--add-tag a,b] [--apply]
```

Same contract across all three apply paths:

- Preview-first. The splicer runs with `write: false` for every target
  first; if anything is refused and `--allow-divergent` is off, no
  files are written.
- Refuses pack-contributed sources (`node_modules/` or `dist/` paths).
  Edit the pack source and re-sign instead.
- Records provenance per applied fix in
  `.sharkcraft/asset-provenance.jsonl`.
- Idempotent. Re-running after a successful apply produces "already
  applied" refusals.

R53 explicitly does NOT auto-apply template-body issues
(`forbidden-legacy-path`, `missing-anchor`, etc.) — those require
editing the template's `files()` resolver, which is function code.
Those remain preview-only.

For the must-fix triage view, use [`shrk doctor --blockers`](./doctor.md).
For the broader "what could I clean up?" view, use
[`shrk lint`](./lint.md).

## `shrk task --next` (R55)

One verb that surveys the whole workspace and proposes the
highest-leverage next action with the exact command to run.

```bash
shrk task --next            # human-readable, single recommendation
shrk task --next --json     # machine shape (sharkcraft.task-next/v1)
```

Inputs surveyed:

- `shrk doctor` blockers (errors + must-fix warning categories).
- `shrk knowledge stale-check` reference checks, partitioned by
  whether the engine emitted a `replaceWith` payload.
- `shrk templates drift` (split by `code` — `missing-barrel` is
  separately mechanically-safe).
- `shrk lint --kind knowledge` action-hint categories.

Deterministic priority order:

1. Doctor blockers — release gated; nothing else ships until they
   clear.
2. Stale knowledge with `replaceWith` — `shrk fix --knowledge-stale
   --apply` is the mechanical fix.
3. Template drift `missing-barrel` — `shrk fix --template-drift
   --apply` creates the missing file.
4. Knowledge action-hint stubs — `shrk fix --action-hints --apply`.
5. Stale knowledge without `replaceWith` — human review then
   `--drop-stale`.
6. Template drift `forbidden-legacy-path` — needs a convention
   decision.
7. Everything else — preview-only.

Pure ranker over existing JSON outputs. No AI. No new asset kinds.
The JSON includes a `totals` block so the agent can sanity-check
the ranker against its own counts.

## `shrk apply --batch <plan>.json` (R55)

Multi-step fix-chain runner. Reads a structured JSON plan and runs
each step via the existing `shrk fix --<kind> --apply --json`
surface, grouping provenance under a deterministic content-hash
`batchId`.

```bash
# Validate the plan without spawning subprocesses:
shrk apply --batch plan.json --dry-run --json

# Real run; stop on first refusal.
shrk apply --batch plan.json --json

# Real run; skip refused steps and continue.
shrk apply --batch plan.json --allow-divergent --json
```

Plan shape (stable, schema-versioned):

```json
{
  "schema": "sharkcraft.apply-batch.v1",
  "steps": [
    { "kind": "action-hints" },
    { "kind": "knowledge-stale" },
    { "kind": "template-drift", "args": { "allow-divergent": true } }
  ]
}
```

Supported step kinds: `action-hints`, `knowledge-stale`,
`template-drift`. Each step's `args` is a flat record forwarded as
`--key value` / `--flag` to the underlying `shrk fix`.

Semantics:

- Each underlying step is itself preview-first internally.
- The batch is **not** atomic across steps: step N+1's refusal does
  not roll back step N's writes. This matches the per-command
  semantics today.
- Fail-closed default: on first refusal the batch stops with
  `stopped: true` in the report.
- With `--allow-divergent`, refused steps are skipped and survivors
  apply (identical to the per-command semantics).
- The `batchId` is a SHA-256 prefix of the canonical plan JSON, so
  the same plan always produces the same id — useful for grouping
  provenance entries in a future history view.

## Adaptive surface (R56)

The visible command surface adapts to the project. A fresh single-app
repo sees ~10 commands; a 50-library monorepo sees the spine plus
everything its packs contribute. Surface management:

```bash
shrk                          # curated landing — shape + surface totals + 4 commands
shrk --about                  # in-binary philosophy summary
shrk surface list             # every command by tier (core / extended / experimental)
shrk surface explain <cmd>    # why a command has its tier
shrk surface enable <cmd> --write   # opt into an experimental command
shrk surface hide <cmd> --write     # hide an extended command from --help
shrk surface reset --write          # clear surface.enabled + surface.hidden
```

Experimental commands refuse with exit code 78 and a structured
`sharkcraft.surface.not-enabled.v1` payload until added to
`sharkcraft.config.ts surface.enabled[]`. The MCP server applies
the same gate. See [docs/surface-tiers.md](./surface-tiers.md) and
[docs/project-shape.md](./project-shape.md) for the full model.

## Diff-aware pre-commit (R56)

Both `shrk check boundaries` and `shrk lint` accept `--since <ref>`.
Default ref candidates: `origin/main`, `main`, `origin/master`,
`master`. Pre-commit recipe:

```bash
# .githooks/pre-commit
shrk check boundaries --since origin/main || exit 1
shrk lint --since origin/main || exit 1
```

`check boundaries` filters violations to the changed file set
(R28 mode). `lint` runs whole-graph and reports the changed-file
count for tooling parity.

## Local usage log (R56)

Each `shrk` invocation appends one JSONL entry to
`.sharkcraft/usage/commands.jsonl`:

```json
{"schemaVersion":"sharkcraft.usage.v1","ts":"...","command":"doctor","exitCode":0,"durationMs":248,"flags":["--json"]}
```

Flag NAMES only, never values. Local-only — never sent anywhere.
Opt-out via `sharkcraft.config.ts usage.enabled: false` or
`SHARKCRAFT_USAGE_DISABLED=1`. Foundation for R57's
`shrk surface --suggest-prune`.

See also: [`docs/sessions.md`](./sessions.md),
[`docs/plan-review.md`](./plan-review.md),
[`docs/security.md`](./security.md),
[`docs/task-packets.md`](./task-packets.md),
[`docs/doctor.md`](./doctor.md).
