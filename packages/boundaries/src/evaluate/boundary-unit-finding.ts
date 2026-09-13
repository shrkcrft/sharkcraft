import { formatUnitLiveness, type IUnitLiveness } from '@shrkcrft/core';
import { boundaryUnitKind } from './boundary-unit-kind.ts';
import type { IBoundaryUnitFinding } from './i-boundary-unit-finding.ts';

/**
 * A settled boundary unit as its report row. Its `reason` is THE per-unit line
 * (`formatUnitLiveness`, `@shrkcrft/core` — `DEAD_SELECTOR_CAUSES` appended to an
 * unmarked unit that matches nothing) without the selector the row names, so no
 * surface words a state itself.
 */
export function boundaryUnitFinding(ruleId: string, unit: IUnitLiveness): IBoundaryUnitFinding {
  const line = formatUnitLiveness(unit);
  const lead = `${unit.label} — `;
  return {
    ruleId,
    unit: boundaryUnitKind(unit.list, unit.unit),
    selector: unit.unit,
    state: unit.state,
    reason: line.startsWith(lead) ? line.slice(lead.length) : unit.message,
    ...(unit.mark?.reason !== undefined ? { markReason: unit.mark.reason } : {}),
    ...(unit.mark?.packageName !== undefined ? { packageName: unit.mark.packageName } : {}),
  };
}
