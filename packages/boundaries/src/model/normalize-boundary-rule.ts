import {
  AppErrorImpl,
  ERROR_CODES,
  err,
  mergeUnitMarks,
  normalizeUnitList,
  ok,
  stampUnitMarks,
  unitProblemsOf,
  type IUnitList,
  type Result,
} from '@shrkcrft/core';
import type { IBoundaryRule } from './boundary-rule.ts';
import type { IBoundaryRuleInput } from './boundary-rule-input.ts';
import { BoundaryMarkableList } from './boundary-markable-list.ts';

const LISTS: readonly BoundaryMarkableList[] = Object.values(BoundaryMarkableList);

/**
 * An authored boundary rule as the LOADED rule (round 13): each of the four
 * selector lists through core's ONE marker parser (`normalizeUnitList`) — the
 * plain string list every reader already consumes, and every
 * `{ pattern, expectEmpty: true, reason? }` entry as a mark in ONE
 * `expectEmptyUnits` ledger, stamped with the contributing pack
 * (`stampUnitMarks`) when the loader knows it.
 *
 * Called by the loader after validation (local rules, pack `boundaryFiles`,
 * `--rule-file` / `--diff-against`) and, IDEMPOTENTLY, at the top of
 * `evaluateBoundaries` — so a hand-built rule (the plan-review /
 * plan-simulation call sites, any API caller) never crashes on an object
 * pattern and never silently ignores a marker. A rule with nothing to
 * normalise comes back as the same object; a malformed entry is an error
 * carrying every `<list>[i]: …` problem (`details.problems`).
 */
export function normalizeBoundaryRule(
  rule: IBoundaryRuleInput | IBoundaryRule,
  packageName?: string,
): Result<IBoundaryRule, AppErrorImpl> {
  const raw = rule as unknown as Readonly<Record<string, unknown>>;
  const problems: string[] = [];
  const normalized = new Map<BoundaryMarkableList, IUnitList>();
  for (const list of LISTS) {
    const entries = raw[list];
    if (entries === undefined) continue;
    const n = normalizeUnitList(entries as readonly unknown[], list);
    if (!n.ok) {
      problems.push(...unitProblemsOf(n.error));
      continue;
    }
    normalized.set(list, n.value);
  }
  if (problems.length > 0) {
    const id = typeof raw['id'] === 'string' ? raw['id'] : '(no id)';
    const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : '';
    return err(
      new AppErrorImpl(ERROR_CODES.CONFIG_INVALID, `boundary rule '${id}': ${problems[0]}${more}`, {
        details: { ruleId: id, problems: [...problems] },
        suggestion: 'write each entry as a plain string, or as { pattern, expectEmpty: true, reason? }',
      }),
    );
  }
  const loaded = rule as IBoundaryRule;
  const found = [...normalized.values()].flatMap((l) => l.marks);
  const existing = loaded.expectEmptyUnits ?? [];
  const stamps = packageName !== undefined && packageName.length > 0 && existing.length > 0;
  if (found.length === 0 && !stamps) return ok(loaded);
  const marks = stampUnitMarks(mergeUnitMarks(existing, found), packageName);
  const units = (list: BoundaryMarkableList): readonly string[] | undefined => normalized.get(list)?.units;
  const exemptFiles = units(BoundaryMarkableList.ExemptFiles);
  const forbiddenImports = units(BoundaryMarkableList.ForbiddenImports);
  const allowedImports = units(BoundaryMarkableList.AllowedImports);
  return ok({
    ...loaded,
    from: units(BoundaryMarkableList.From) ?? loaded.from,
    ...(exemptFiles !== undefined ? { exemptFiles } : {}),
    ...(forbiddenImports !== undefined ? { forbiddenImports } : {}),
    ...(allowedImports !== undefined ? { allowedImports } : {}),
    ...(marks.length > 0 ? { expectEmptyUnits: marks } : {}),
  });
}
