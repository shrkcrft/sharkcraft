# Local metrics — design (R45)

Status: **design only** — no implementation in R45.

## Goal

Let SharkCraft surface *which rules trigger most*, *which templates are
used*, *which knowledge entries are queried*, *which commands run* — for
the local maintainer's benefit. Strictly **local**. Strictly **opt-in**.
Never a network call.

## Non-goals

- No telemetry to Anthropic, GitHub, or anyone else.
- No anonymous aggregation across users.
- No build-time data collection.
- No PII collection of any kind.

## Storage

A single append-only JSONL file:

```
.sharkcraft/local-metrics.jsonl
```

One event per line, schema:

```ts
interface ILocalMetricsEvent {
  schema: 'sharkcraft.local-metrics/v1';
  ts: string;          // ISO8601
  kind:
    | 'command-run'
    | 'rule-triggered'
    | 'knowledge-queried'
    | 'template-rendered'
    | 'warning-acknowledged';
  id: string;          // rule id / knowledge id / template id / command path
  context?: {
    cwd?: string;
    sessionId?: string;
    durationMs?: number;
    exitCode?: number;
  };
}
```

Events are written via a thin sink interface — production code calls
`maybeRecordEvent(ev)` which no-ops unless the user has enabled local
metrics.

## Enabling

Off by default. Two ways to enable:

1. `shrk metrics local enable` writes `.sharkcraft/metrics.enabled` (a
   marker file). The sink reads this on every call.
2. `SHRK_LOCAL_METRICS=1` env var enables for the current process only.

Disabling: `shrk metrics local disable` removes the marker file.

## Surfacing

- `shrk metrics local report` — frequency table over the last N events
  (default: all). Groups by `kind` then by `id`. Pure read.
- `shrk metrics local report --since <iso-date>` — windowed report.
- `shrk metrics local reset` — truncates the JSONL file. Local-only.

## Why this is safe

- The file is local, gitignored by default (add to `.gitignore` when the
  feature ships).
- No network egress. No SDK. No analytics package.
- The opt-in mechanism is a *file*, not a config flag in
  `sharkcraft.config.ts` — making it explicit and reversible.

## Implementation scope (when this lands)

1. Add `IMetricsSink` interface in `@shrkcrft/core` with a single
   `record(event)` method.
2. Wire `command-run` events at `packages/cli/src/main.ts` dispatch.
3. Wire `rule-triggered` events at `inspectSharkcraft` rule resolution.
4. Wire `knowledge-queried` events at `knowledgeService.search`.
5. Wire `template-rendered` events at `templateService.render`.
6. Add `shrk metrics local` group with `enable / disable / report /
   reset`.
7. Document explicitly in `docs/safety-model.md` — opt-in, local-only.

## Estimated complexity

~3 days of focused engineering. Not in scope for R45.
