# Repository memory

`shrk memory build|report|risk|files|diagnostics|reset` produces a
**local-only, private** index of historical signals from
`.sharkcraft/sessions/`, `.sharkcraft/reports/`, `.sharkcraft/bundles/`,
and `.sharkcraft/plans/`.

## What's in the index

- Frequently touched files (with conflict / warning / failed-validation counts).
- Plans that historically had conflicts.
- Recurring boundary / policy violations.
- Failed validation commands and slow validation commands.
- Release blockers and pack issues seen.
- Recent task types (intent kinds).
- Playbook success / failure counts.
- High-activity constructs.

## Commands

```
shrk memory build              # rebuild / refresh the index
shrk memory report             # human-readable summary
shrk memory risk "<task>"      # task-relevant overlap with history
shrk memory files              # ranked risky files
shrk memory diagnostics        # recurring diagnostics
shrk memory reset [--write]    # default dry-run; --write deletes only .sharkcraft/memory
```

## Storage

`.sharkcraft/memory/index.json` — schema `sharkcraft.memory/v1`.

## Privacy / safety pledge

- **No network**. No `fetch`, no `http`, no telemetry endpoint.
- **No model calls**. No embeddings, no LLM tokenisation.
- **No mutation of source files**. Writes only happen inside
  `.sharkcraft/memory/`.
- `memory reset --write` refuses to step outside `.sharkcraft/memory/`.

## Integrations

- `shrk risk --include-memory` **adjusts the score** (R24). Output carries
  `baseScore` / `adjustedScore` and a `memory` block with signals + reasons.
- `shrk orchestrate --risk-aware` and `shrk view <role> --task` surface
  memory-driven warnings when the index has overlap with the task.
- `shrk contract` includes memory-driven risks via `taskRisk.memory`.
- `shrk brief --include-memory` folds memory warnings into the unified
  agent brief (R46 renamed `handoff` → `brief`).
- `shrk agent graph` adds a `memory` node when an index exists.

## Memory-weighted risk rules (R24)

- Memory **can raise** risk, never lower it. `adjustedScore ≥ baseScore`
  is a hard invariant.
- Memory adjustment is **capped at 14** so a hot index can't fully invent
  risk on its own.
- If the index is older than 30 days the adjustment is **halved** and
  surfaced as `memory.stale = true`.
- If no index exists, `memory.missing = true` and `memory.score = 0`.

## Memory drift / diff (R25)

`shrk memory build --write-snapshot` archives the index under
`.sharkcraft/memory/history/<ts>-memory.json`. Snapshots are append-only.

```bash
shrk memory build --write-snapshot
shrk memory snapshots                          # list archive
shrk memory diff <old.json> [new.json]         # compare two indexes
shrk memory drift [--previous <snapshot.json>] # current index vs latest snapshot
shrk memory drift --format markdown            # PR-friendly output
```

`IMemoryDiffReport` (schema `sharkcraft.memory-diff/v1`) reports:

- `riskTrend`: `improving` / `stable` / `worsening` / `unknown`
- `newRiskyFiles[]`, `resolvedRiskyFiles[]`
- `worseningFiles[]`, `improvingFiles[]` (per-file score delta)
- `newRecurringDiagnostics[]`, `resolvedDiagnostics[]`, `diagnosticDeltas[]`
- `newPlanConflicts[]`, `newFailedValidationCommands[]`
- `newRecurringBoundaryViolations[]`, `newRecurringPolicyViolations[]`
- `newPackIssues[]`, `changedTopConstructs[]`
- `suggestedActions[]`

MCP: `get_memory_diff`, `get_memory_drift` (read-only).

## MCP

`get_memory_report`, `get_memory_risk`, `list_memory_files`,
`get_memory_diagnostics` — all read-only. R25 adds
`get_memory_diff` and `get_memory_drift` (read-only).
