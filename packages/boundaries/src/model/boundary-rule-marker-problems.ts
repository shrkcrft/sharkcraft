import { markedListFailOnEmptyConflict, type IUnitList } from '@shrkcrft/core';
import { importPatternDefect, importPatternNeverJudgedDead } from '../scan/import-pattern.ts';
import type { ForbiddenMatchMode, IBoundaryRuleValidationIssue } from './boundary-rule.ts';
import { boundaryPatternOverlaps } from './boundary-rule-scope.ts';
import { BoundaryMarkableList } from './boundary-markable-list.ts';

/**
 * The marker refusals a boundary rule adds on top of core's marker shape
 * (round 13, DECISIONS §4), over the NORMALISED lists:
 *
 *   - a marker on a pattern dead by its SHAPE can never go live, so it could
 *     only ever silence a real problem: an `importPatternDefect`, a
 *     `forbiddenImports` entry a kept sibling already covers (redundant), or an
 *     `allowedImports` entry a forbidden one shadows. Each is proved from the
 *     rule alone, through the same authorities the evaluator and `boundaries
 *     explain` read (`importPatternDefect`, `boundaryPatternOverlaps`);
 *   - a marker on a pattern the dead-unit judge can NEVER call dead (a
 *     relative one, a leading `*`, one a runtime builtin matches —
 *     `importPatternNeverJudgedDead`) could only ever read went-live: refused
 *     with that explanation (K5);
 *   - `failOnEmpty: true` with EVERY `from` inclusion marked asserts both "an
 *     empty result is intended" and "an empty result fails" (core's one
 *     conflict rule, `markedListFailOnEmptyConflict`). Partial marking is legal.
 */
export function boundaryRuleMarkerProblems(
  lists: {
    readonly from?: IUnitList;
    readonly forbiddenImports?: IUnitList;
    readonly allowedImports?: IUnitList;
  },
  mode: ForbiddenMatchMode,
  failOnEmpty: unknown,
): IBoundaryRuleValidationIssue[] {
  const issues: IBoundaryRuleValidationIssue[] = [];
  const markedIn = (list: IUnitList | undefined, listPath: BoundaryMarkableList): ReadonlySet<string> =>
    new Set((list?.marks ?? []).filter((m) => m.list === listPath).map((m) => m.unit));
  const forbiddenMarked = markedIn(lists.forbiddenImports, BoundaryMarkableList.ForbiddenImports);
  const allowedMarked = markedIn(lists.allowedImports, BoundaryMarkableList.AllowedImports);

  const refuseDefects = (
    list: IUnitList | undefined,
    listPath: BoundaryMarkableList,
    marked: ReadonlySet<string>,
    listMode: ForbiddenMatchMode,
  ): void => {
    const reported = new Set<string>();
    list?.units.forEach((unit, i) => {
      if (!marked.has(unit) || reported.has(unit) || importPatternDefect(unit, listMode) === undefined) return;
      reported.add(unit);
      issues.push({
        field: `${listPath}[${i}]`,
        message: `'${unit}' is marked expectEmpty, but a defective pattern can never go live — fix the pattern; a marker cannot waive a defect`,
      });
    });
  };
  refuseDefects(lists.forbiddenImports, BoundaryMarkableList.ForbiddenImports, forbiddenMarked, mode);
  refuseDefects(lists.allowedImports, BoundaryMarkableList.AllowedImports, allowedMarked, 'exact');

  // Round 13 (K5): a marker on a pattern the dead-unit judge can NEVER call
  // dead — a relative one, a leading `*`, one a runtime builtin matches — can
  // only ever read went-live, so it would print a stale-marker line from the
  // moment it is written. The judge's own reach rules decide it
  // (`importPatternNeverJudgedDead`).
  const refuseUnjudgeable = (
    list: IUnitList | undefined,
    listPath: BoundaryMarkableList,
    marked: ReadonlySet<string>,
    listMode: ForbiddenMatchMode,
  ): void => {
    const reported = new Set<string>();
    list?.units.forEach((unit, i) => {
      if (!marked.has(unit) || reported.has(unit)) return;
      const never = importPatternNeverJudgedDead(unit, listMode);
      if (never === undefined) return;
      reported.add(unit);
      issues.push({
        field: `${listPath}[${i}]`,
        message: `'${unit}' is marked expectEmpty, but ${never} — a marker on it could only ever read went-live; write the plain pattern (it needs no expectEmpty)`,
      });
    });
  };
  refuseUnjudgeable(lists.forbiddenImports, BoundaryMarkableList.ForbiddenImports, forbiddenMarked, mode);
  refuseUnjudgeable(lists.allowedImports, BoundaryMarkableList.AllowedImports, allowedMarked, 'exact');

  if (forbiddenMarked.size > 0 || allowedMarked.size > 0) {
    const overlaps = boundaryPatternOverlaps({
      forbiddenImports: lists.forbiddenImports?.units ?? [],
      allowedImports: lists.allowedImports?.units ?? [],
      forbiddenMatch: mode,
    });
    for (const o of overlaps.redundantForbidden) {
      if (!forbiddenMarked.has(o.pattern)) continue;
      issues.push({
        field: `${BoundaryMarkableList.ForbiddenImports}[${o.index}]`,
        message: `'${o.pattern}' is marked expectEmpty, but '${o.by}' already covers every import it could match — a redundant pattern can never decide a verdict, so it can never go live; delete it`,
      });
    }
    for (const o of overlaps.shadowedAllowed) {
      if (!allowedMarked.has(o.pattern)) continue;
      issues.push({
        field: `${BoundaryMarkableList.AllowedImports}[${o.index}]`,
        message:
          `'${o.pattern}' is marked expectEmpty, but forbidden '${o.by}' is checked first and covers it — it can never admit an import, so it can never go live; ` +
          `carve the subpath out with exceptions[{ path, target, reason }]${mode === 'package' ? " or set forbiddenMatch: 'exact'" : ''}`,
      });
    }
  }

  if (lists.from !== undefined) {
    const conflict = markedListFailOnEmptyConflict(
      lists.from,
      BoundaryMarkableList.From,
      typeof failOnEmpty === 'boolean' ? failOnEmpty : undefined,
    );
    if (conflict !== undefined) issues.push({ field: 'failOnEmpty', message: conflict });
  }
  return issues;
}
