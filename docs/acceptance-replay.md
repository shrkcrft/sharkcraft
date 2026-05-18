# Acceptance replay (R39)

`shrk changes acceptance-replay` answers "given the changes I'm about
to ship, which validation commands should I re-run?" — with reasons,
and without executing any of them.

It builds on the R31 [`changes summary`](changes-summary.md) report
and the R38 changed-only preflight planner.

## Commands

```bash
shrk changes acceptance-replay --since R38
shrk changes acceptance-replay --staged
shrk changes acceptance-replay --files a.ts,b.ts
shrk changes acceptance-replay --round R39 --profile strict --format json
```

## Flags

- `--since <ref>` / `--staged` / `--files a,b,c` — same diff selector
  as `shrk changes summary`.
- `--round <name>` / `--label <name>` — optional label captured in the
  report.
- `--profile changed-only` (default) — only fire conditional gates
  triggered by the change set; baseline gates always run.
- `--profile standard` — emit the same set as `changed-only`, but
  also list every skipped gate with the reason it was skipped.
- `--profile strict` — emit every gate regardless of trigger.
- `--format text|markdown|json` — output format.
- `--output <file>` — write to a file instead of stdout.

## Gate categories

| Category | Examples |
| --- | --- |
| `baseline` | `bun x tsc --noEmit`, `bun test`, `shrk doctor` — always emitted. |
| `gate` | Triggered by change shape — `shrk safety audit --deep` on MCP touches; `shrk check boundaries --changed-only` on package touches; `shrk packs doctor --require-signatures` on pack asset touches; `bun run release:preflight` on generator/apply touches. |
| `suggested` | `shrk knowledge stale-check --ci`, `shrk templates drift` — softer hints from the changes-summary suggested list. |

## Schema

`sharkcraft.acceptance-replay/v1`. The report is a structured punch
list — it tells you what to run, in what order, with the reason and
expected exit code. **It does not execute anything.**

## MCP

- `get_acceptance_replay` — read-only. Same input shape as the CLI.

## Why not just run the gates automatically?

Acceptance replay is a *plan*, not a *script*. Different teams want to
run the gates in different orders, on different CI lanes, with
different parallelism. By keeping the surface advisory, the same
output is usable from a dev shell, a CI configuration generator, an
MCP agent, and a PR-review automation — without baking shell execution
into any of them.
