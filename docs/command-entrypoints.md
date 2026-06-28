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
| Debugging why an entry was / was not surfaced | `shrk explain <id> --for-task "<task>"` |
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
| `shrk explain <id> --for-task "<task>"` | `explain` | Debug surface — explains how the ranker scored an entry. Not the main workflow entrypoint. (R46 folded the older ranker-explain CLIs into `shrk explain` and `shrk recommend --why-not`.) |

The metadata is now on every catalog entry — run
`shrk explain <command>` to see `surface`, `audience`,
`role`, `preferredCommand`, and `overlapsWith` for any of them.

## Discovery commands

```bash
shrk commands                 # primary + common (the default-help view)
shrk commands --advanced      # advanced / machine surfaces
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

## See also

- `docs/start-here.md` — onboarding flows.
- `docs/overview.md` — what SharkCraft is and isn't.
- `docs/recommend.md` — the canonical human entrypoint.
- `docs/why.md` — ranker explainability.
