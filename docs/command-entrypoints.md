# Command entrypoints — which command should I run first?

SharkCraft ships 380+ catalog entries. Most of them are advanced or
domain-specific. This page is the one-screen answer to "which command
do I reach for first?".

## The short answer

| You are … | First command |
| --- | --- |
| A human at a terminal asking "what should I do?" | `shrk recommend "<task>"` |
| A human exploring SharkCraft for the first time | `shrk start-here` |
| An AI agent making your first MCP call for a task | `prepare_agent_task` |
| Looking for a specific registry entry (knowledge / rule / template) | `shrk search "<query>"` |
| Debugging why an entry was / was not surfaced | `shrk explain <id>` (the per-task ranker trace is the MCP tool `explain_ranker`) |
| Piping a machine-readable task packet into another tool | `shrk task "<task>" --json` |
| About to ship and want a go / no-go | `shrk release readiness` |
| Validating the workspace before working | `shrk doctor` |

Everything else is a specialisation. If you're not sure, run
`shrk recommend "<task>"` and read the suggestions.

## Human / agent / CI

| Audience | Canonical first commands |
| --- | --- |
| **Human** (TTY) | `shrk start-here`, `shrk recommend "<task>"`, `shrk doctor`, `shrk context --task "<task>" --full`, `shrk explore <path>` |
| **AI agent** (MCP) | `prepare_agent_task`, `get_relevant_context`, `get_task_packet` (only when you really want the full packet — `prepare_agent_task` is preferred) |
| **CI** | `shrk doctor`, `shrk quality`, `shrk safety audit --deep`, `shrk release readiness`, `bun run release:preflight` |

The same data flows through all three surfaces. The CLI is the only
write path; MCP never writes.

## The overlap problem (and how R41 solved it)

These six commands all look like "tell me about my task":

| Command | Role (R41 `taskRole`) | When to use |
| --- | --- | --- |
| `shrk recommend "<task>"` | `start` | **Canonical human entrypoint.** "What should I do?" — gives you a ranked list of commands. |
| `shrk context --task "<task>"` | `context` | Token-budgeted context bundle for doing the task. Action-like verbs auto-promote commands-first; otherwise text mode is summary-only (pass `--full` for the long body). |
| `shrk task "<task>"` | `context` (machine) | Machine task packet — rules + templates + pipelines + verification commands + forbidden actions. **Primary consumer is agents / JSON pipes.** For human workflow guidance use `shrk recommend`. |
| `shrk search "<query>"` | `search` | Registry / contributions search. **Not** "what should I do?" — for that use `shrk recommend`. |
| `shrk explain <id>` | `explain` | Debug surface — explains an entry and why it surfaces. Not the main workflow entrypoint. (R46 folded the older ranker-explain CLIs into `shrk explain`; the per-task ranker trace is the MCP tool `explain_ranker`.) |

The metadata is now on every catalog entry — run
`shrk explain <command>` to see `surface`, `audience`,
`role`, `preferredCommand`, and `overlapsWith` for any of them.

## Discovery commands

```bash
shrk commands                 # primary + common (the default-help view)
shrk commands advanced        # advanced / machine surfaces
shrk commands --all           # everything, including legacy / retired
shrk commands deprecated      # only deprecated / retired with replacements
shrk explain <cmd>            # R41-enriched per-command detail
shrk commands search <query>  # substring search
shrk commands doctor          # catalog consistency (CI gate)
shrk commands ux-check        # missing metadata / overlap UX issues
```

The internal catalog-navigation commands (`shrk commands primary`,
`shrk commands legacy`, `shrk commands overlaps`,
`shrk commands taxonomy`, `shrk commands machine`,
`shrk commands surface`) are hidden from default help under R46 — they
are still callable but no longer promoted.

## When to run the validation loop

```bash
shrk preflight                # change-aware read-only gate orchestrator
shrk doctor                   # workspace doctor — first thing in CI
shrk self-config doctor       # cross-reference graph doctor
shrk safety audit --deep      # before tagging a release
shrk release readiness        # the aggregate gate
bun run release:preflight     # the real CI gate
```

Run `shrk doctor` and `shrk self-config doctor` regularly while you
work. Run `shrk safety audit --deep` and `release readiness` before
shipping.

## Suggested first 5 commands

### For a new human user

```bash
shrk start-here                       # 30-second orientation
shrk doctor                           # is the workspace healthy?
shrk recommend "<your task>"          # ranked next commands
shrk commands primary                 # curated short list
shrk explain <interesting>   # learn one command in depth
```

### For an AI agent

```text
prepare_agent_task("<task>")          # canonical agent first call
get_relevant_context({ task })        # fall back if you only need context
get_task_packet({ task })             # full packet — rarely needed before prepare_agent_task
get_command_catalog                   # browsable command list
get_safety_audit                      # confirm safety posture
```

Agents writing files: **don't.** MCP is read-only. Every MCP tool
returns a `nextCommand` hint; humans run the writes on the CLI.

## Where this is enforced

- `packages/cli/src/commands/command-catalog.ts` — entries carry
  `surface`, `intendedAudience`, `taskRole`, `preferredCommand`,
  `overlapsWith`, `replacedBy`, `machineOnly`, and (R42)
  `lifecycle` / `deprecatedSince` / `removeAfter` / `reason` /
  `showInDefaultHelp`.
- `packages/inspector/src/entrypoint-matrix.ts` — the entrypoint
  classes the banners reference.
- `shrk commands ux-check` — catches missing metadata, overlap without
  a `preferredCommand`, machine surfaces marked as primary.
- `shrk commands docs-check` (R42) — catches stale doc references and
  docs that promote deprecated commands.
- `shrk commands retirement-plan` (R42) — groups every catalog entry
  needing lifecycle attention (deprecated / aliases / machine-in-help /
  overlapping / missing replacedBy / legacy without removeAfter).

## R42 default-view rules

- Bare `shrk` prints a short product start screen (4 canonical
  commands + how to see more). `shrk --full-help` keeps the long form.
- `shrk commands` (no subcommand) prints the compact view: primary +
  curated common. `shrk commands --all` brings back the full catalog.
- Free-form input (`shrk rename a service safely`) returns a
  did-you-mean pointing at `shrk recommend "<task>"` — no writes,
  exit 2.

## R42 verbosity vocabulary

| Flag | Meaning |
| --- | --- |
| (no flag) | Shortest human-friendly default. |
| `--compact` | Same as default; declared explicitly. |
| `--verbose` | Expanded human output (still readable in a terminal). |
| `--full` | Complete human output where the long body exists (e.g. `shrk context --full`). |
| `--json` / `--machine-json` | Machine output. JSON shape is the contract. |
| `--format text|markdown|html|json` | Report-style commands (`shrk report …`). |
| `--actions-only` | Command/action-focused output (skip prose). |
| `--legacy` | Old renderer only (`shrk search --legacy`). |

See `docs/verbosity-vocabulary.md` for the canonical reference and the
UX-check rules.

## `shrk recommend` — one ranked list (round 11)

`shrk recommend`, MCP `recommend_commands` and `shrk context` (Top commands)
render ONE ranked list built in the inspector (`rankRecommendationCandidates`).
A matched routing hint used to be scored and then dropped before the headline
for every non-create intent; that is structurally impossible now. Every signal
proposes candidates, each normalised by its own floor so 1.0 means "just
strong enough":

| Source | Proposes | Raw score | Floor |
|---|---|---|---|
| `diagnostic` | a `--from-error` diagnostic's next command | 1 | 1 |
| `planning` | `shrk grounding "<task>" --json`, PINNED first for a planning query; never counts toward confidence | — | — |
| `routing-hint` | every `recommends.commands` entry of a matched hint | hint score | 3 |
| `ranker-template` | `shrk gen <template> <name> --dry-run` (the shared ranker's top template) | `rankAll` score | 6 |
| `ranker-pipeline` | `shrk task "<task>"` (the top pipeline) | `rankAll` score | 8 |
| `recipe` | a built-in keyword recipe's commands (THE term matcher: `pr` no longer fires inside "pricing") | 2 × distinct matched terms | 2 |
| `intent-fallback` | change-intent's first command — only when nothing is confident | fixed 0.5 | — |

Ties break on source precedence (diagnostic > routing hint > ranker template >
ranker pipeline > recipe > intent fallback — project data beats built-ins),
then declaration order. Duplicate commands are merged; the kept row names every
source that proposed it.

**Eligibility.** Suppressed rows stay in `--json` `ranked` with a
`suppressedReason`, and the human output counts them in one line — never silent:

- `non-create-intent` — a source-writing command (`shrk gen …`) on a query THE
  query-intent classifier (`classifyQueryIntent`) does not read as create/build
  work ("fix the broken build", "why does the new route fail": a repair or
  diagnosis marker vetoes a create word used as a noun or adjective). Config
  `recommend.scaffoldRequiresCreateIntent: false` lifts it.
- `single-incidental-term` — a ranker match sharing fewer than 2 distinct
  query terms (`matchedTerms`) with the query; one incidental word is not evidence.
- `below-floor` — a source-writing command while nothing is confident, or
  below its own floor.

**Confidence** (`deriveRecommendationConfidence`, the one authority) is a
function of the same scores: `confident` is true when an eligible routing-hint,
ranker, recipe or diagnostic row cleared the floor. `high`, unless a
different-source runner-up is within 25% of the top (or a recipe competes with
a ranker headline — `conflict-recipe-vs-ranker` plus a `review:` warning), which
is `medium`. The report carries the shared vocabulary `confident`, `verdict`
(`confident` | `no-confident-match` | `no-match`), `floor` and `bestScore` (as
`shrk reuse` does), plus `intent`; each row carries `source`, `sourceId`,
`score`, `weak` and `attribution`.

When nothing is confident the human output reads
`=== No confident match (best 0.67 of floor 1.00 — routing hint "x" (score 2, floor 3)) ===`,
lists the weak candidates with `?` instead of `$`, prints the coverage-gap
suggestions, and the next command is the read-only fallback or
`shrk start-here` — never a source-writing guess. When confident, `nextCommand`
is always the first rendered row (re-picked after surface gating).

**The floor** is a multiplier in normalised units: `--min-score <n>` (CLI) >
`minScore` (MCP) > config `recommend.minScore` > 1. `--require-confident` exits
`2` when nothing is confident (global `--strict` → `1`); the default exit stays
`0` — `recommend` is not a gate.

```ts
// sharkcraft/sharkcraft.config.ts
export default {
  recommend: { minScore: 1.5, scaffoldRequiresCreateIntent: true },
};
```

## See also

- `docs/start-here.md` — onboarding flows.
- `docs/overview.md` — what SharkCraft is and isn't.
- `docs/recommend.md` — the canonical human entrypoint.
- `docs/why.md` — ranker explainability.
