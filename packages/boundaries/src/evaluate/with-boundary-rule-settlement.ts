import { RuleEmptiness, type UnitLivenessState } from '@shrkcrft/core';
import { BoundaryMarkableList } from '../model/boundary-markable-list.ts';
import type { IBoundaryRuleCoverage } from './evaluate-boundaries.ts';
import type { IBoundaryRuleSettlement } from './i-boundary-rule-settlement.ts';

/**
 * A rule's coverage record with a settlement applied (round 13): its status,
 * skip, verdict coverage, acceptance, dead list, settled units and every row's
 * `state`. The evaluator and the orchestrator's unread re-settle both build the
 * record here, so neither can carry a field the other drops: a skip reason or
 * an acceptance the new settlement does not carry is gone, never inherited.
 */
export function withBoundaryRuleSettlement(
  counts: Pick<
    IBoundaryRuleCoverage,
    | 'ruleId'
    | 'severity'
    | 'filesInScope'
    | 'exemptFilesInScope'
    | 'edgesInScope'
    | 'violations'
    | 'suppressed'
    | 'fromGlobs'
    | 'forbidden'
    | 'allowed'
    | 'exemptions'
    | 'exceptions'
  >,
  s: IBoundaryRuleSettlement,
): IBoundaryRuleCoverage {
  const stateOf = new Map<string, UnitLivenessState>(s.settled.units.map((u) => [`${u.list} ${u.unit}`, u.state]));
  const withState = <T extends { readonly state?: UnitLivenessState }>(row: T, list: string, unit: string): T => {
    const { state: _previous, ...bare } = row;
    const state = stateOf.get(`${list} ${unit}`);
    return (state !== undefined ? { ...bare, state } : bare) as T;
  };
  return {
    ruleId: counts.ruleId,
    severity: counts.severity,
    status: s.status,
    ...(s.skipReason !== undefined ? { skipReason: s.skipReason } : {}),
    ...(s.failedOnEmpty ? { failedOnEmpty: true } : {}),
    ...(s.emptiness.state === RuleEmptiness.IntendedEmpty ? { acceptedAsIntendedEmpty: true as const } : {}),
    filesInScope: counts.filesInScope,
    exemptFilesInScope: counts.exemptFilesInScope,
    edgesInScope: counts.edgesInScope,
    violations: counts.violations,
    suppressed: counts.suppressed,
    fromGlobs: counts.fromGlobs.map((g) => withState(g, BoundaryMarkableList.From, g.glob)),
    forbidden: counts.forbidden.map((f) => withState(f, BoundaryMarkableList.ForbiddenImports, f.pattern)),
    allowed: counts.allowed.map((a) => withState(a, BoundaryMarkableList.AllowedImports, a.pattern)),
    exemptions: counts.exemptions.map((e) =>
      e.origin === 'from-negation'
        ? withState(e, BoundaryMarkableList.From, `!${e.glob}`)
        : e.origin === 'exemptFiles'
          ? withState(e, BoundaryMarkableList.ExemptFiles, e.glob)
          : e,
    ),
    exceptions: counts.exceptions,
    deadUnits: s.deadUnits,
    unitLiveness: s.settled.units,
    coverage: s.coverage,
    ...(s.unitAcceptance !== undefined ? { unitAcceptance: s.unitAcceptance } : {}),
    ...(s.units !== undefined ? { units: s.units } : {}),
  };
}
