import {
  settleRuleEmptiness,
  settleUnitLiveness,
  UnitDeadWeight,
  unitStateLists,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import { BoundaryMarkableList } from '../model/boundary-markable-list.ts';
import { boundaryRuleFailsOnEmpty } from '../model/boundary-rule-scope.ts';
import { boundaryUnitFinding } from './boundary-unit-finding.ts';
import type { BoundaryRuleStatus, IBoundaryDeadUnit } from './evaluate-boundaries.ts';
import type { IBoundaryRuleSettleInput } from './i-boundary-rule-settle-input.ts';
import type { IBoundaryRuleSettlement } from './i-boundary-rule-settlement.ts';

/**
 * THE settle of one boundary rule (round 13). The evaluator calls it with what
 * it observed; the orchestrator's unread re-settle (`boundaryUnitLiveness` —
 * `check boundaries` AND `--diff-against`) calls it with the claims an unread
 * file could refute withdrawn. One function, so the two paths can never settle
 * one rule differently:
 *
 *   - units through core's `settleUnitLiveness`: a `from` inclusion is
 *     Coverage weight (dead → a shortfall, exit 2), every other list is
 *     Advisory (listed, ✓ withheld); a marked unit whose target does not
 *     exist is intended-empty (record B, printed `accepted by expectEmpty`),
 *     one whose target exists went live;
 *   - the rule's emptiness through `settleRuleEmptiness`: a rule whose every
 *     `from` inclusion is intended-empty and that matched no file is
 *     IntendedEmpty — accepted, never failOnEmpty; an unread governed file
 *     makes it partial, never "matched nothing";
 *   - the dead list is the settled `.dead` (unmarked units only), each worded
 *     by the one per-unit line.
 */
export function settleBoundaryRule(input: IBoundaryRuleSettleInput): IBoundaryRuleSettlement {
  const universeNote = input.fileUniverse === 'edges' ? ' (file list derived from import edges)' : '';
  const settled = settleUnitLiveness({
    unitLabel: 'scope globs',
    acceptanceUnitLabel: 'selector units',
    weight: UnitDeadWeight.Advisory,
    observations: input.observations,
    marks: input.rule.expectEmptyUnits ?? [],
    deadSummary: `reached no governed file among ${input.filesScanned} scanned${universeNote}`,
  });
  const noFiles = `from globs matched 0 of ${input.filesScanned} scanned files: ${input.includeGlobs.join(', ')}`;
  const emptiness = settleRuleEmptiness({
    unitLabel: 'governed files',
    filesMatched: input.filesInScope + input.exemptFilesInScope,
    unitsMatched: input.filesInScope,
    unread: input.unread,
    emptiedByNegations: input.filesInScope === 0 && input.exemptFilesInScope > 0,
    emptiedReason: `every file its from globs match is exempt (${input.exemptFilesInScope} file(s))`,
    liveness: settled,
    primaryLists: [BoundaryMarkableList.From],
    failOnEmpty: boundaryRuleFailsOnEmpty(input.rule),
    noFilesReason: noFiles,
    noUnitsReason: noFiles,
  });
  const status: BoundaryRuleStatus = emptiness.skipped ? 'skipped' : input.violations > 0 ? 'failed' : 'passed';
  const coverage: IVerdictCoverage = emptiness.coverage ??
    settled.shortfall ?? { unit: 'scope globs', expected: 0, examined: 0 };
  const deadUnits: IBoundaryDeadUnit[] = settled.dead.map((u) => {
    const f = boundaryUnitFinding(input.rule.id, u);
    return {
      ruleId: f.ruleId,
      unit: f.unit,
      selector: f.selector,
      reason: f.reason,
      ...(u.cause !== undefined ? { cause: u.cause } : {}),
    };
  });
  const hasUnits = settled.dead.length + settled.intendedEmpty.length + settled.wentLive.length > 0;
  return {
    settled,
    emptiness,
    status,
    ...(emptiness.skipReason !== undefined ? { skipReason: emptiness.skipReason } : {}),
    failedOnEmpty: emptiness.fails,
    coverage,
    ...(settled.acceptance !== undefined ? { unitAcceptance: settled.acceptance } : {}),
    ...(hasUnits ? { units: unitStateLists(settled) } : {}),
    deadUnits,
  };
}
