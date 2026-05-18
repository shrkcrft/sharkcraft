# Uncertainty (R31 → R34)

SharkCraft surfaces confidence + signals so AI agents and humans know
when a recommendation is weak. The R34 shared shape:

```ts
interface IUncertaintyReport {
  schema: 'sharkcraft.uncertainty-report/v1';
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  reasons: readonly string[];
  missingSignals: readonly { id: string; message: string }[];
  conflictingSignals: readonly { id: string; message: string }[];
  suggestedCommands: readonly string[];
  safeFallbackCommand: string;
  whatWouldIncreaseConfidence: readonly string[];
}
```

The R31 `IUncertaintySummary` continues to work; `uncertaintyReportFromSummary`
converts it.

## Surfaces

The R34 shape is wired into:

- `shrk search "<query>"` — section 6 of the 7-section output.
- `prepare_agent_task` MCP tool — every call returns confidence +
  missingSignals.
- `shrk task` / `shrk brief` — R31 baseline.

Future rounds will continue wiring it into `recommend`, `coverage
scaffolds`, `pr summary`, `ci predict`, `handoff`, `contract`.

## Low-confidence rendering

When confidence is `low` or `unknown`, the text renderer surfaces a
prose warning, not just a number:

```
⚠ Low confidence — see "What would increase confidence" below.
```

## Schemas

- `sharkcraft.uncertainty/v1` (R31 summary)
- `sharkcraft.uncertainty-report/v1` (R34 shared shape)
