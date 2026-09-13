import type { AppErrorImpl } from '../result/errors.ts';
import { err, ok, type Result } from '../result/result.ts';
import { describeEntryValue } from './describe-entry-value.ts';
import type { IUnitMap } from './i-unit-map.ts';
import type { IUnitMark } from './i-unit-mark.ts';
import { isMarkerObject } from './is-marker-object.ts';
import { markerEntryProblems } from './marker-entry-problems.ts';
import { unitProblemsError } from './unit-problems-error.ts';
import { UnitEntryForm } from './unit-entry-form.ts';

/**
 * THE parser for a boost map (search tuning `boostIds`, `taskHints[i].boostIds`):
 * values `number | { weight, expectEmpty: true, reason? }` in, the plain
 * `key → number` map every reader consumes plus the marker ledger out. The UNIT
 * is the key.
 *
 *   normalizeUnitMap({ 'knowledge:a': 2, 'knowledge:b': { weight: 3, expectEmpty: true } }, 'boostIds')
 *   → ok({ values: { 'knowledge:a': 2, 'knowledge:b': 3 },
 *          marks: [{ list: 'boostIds', unit: 'knowledge:b' }] })
 *
 * Refused LOUDLY, each as a `<listPath>["<key>"]: …` problem: a value that is
 * neither a number nor a well-formed marker (an older engine silently clamped
 * such a value to 0), and every marker defect `markerEntryProblems` names.
 * Clamping stays the reader's job — a marked weight is clamped like a plain one.
 * Idempotent: a plain map returns `{ values: map, marks: [] }`.
 */
export function normalizeUnitMap(record: unknown, listPath: string): Result<IUnitMap, AppErrorImpl> {
  if (!isMarkerObject(record)) {
    return err(
      unitProblemsError(
        listPath,
        [`${listPath}: must be a map of key → number or { weight, expectEmpty: true, reason? } (got ${describeEntryValue(record)})`],
        UnitEntryForm.WeightMap,
      ),
    );
  }
  const values: [string, number][] = [];
  const marks: IUnitMark[] = [];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const at = `${listPath}[${JSON.stringify(key)}]`;
    if (typeof value === 'number') {
      values.push([key, value]);
      continue;
    }
    if (!isMarkerObject(value)) {
      problems.push(`${at}: must be a number or { weight, expectEmpty: true, reason? } (got ${describeEntryValue(value)})`);
      continue;
    }
    const own = markerEntryProblems(value, UnitEntryForm.WeightMap);
    if (own.length > 0) {
      for (const p of own) problems.push(`${at}: ${p}`);
      continue;
    }
    const weight = value['weight'];
    if (typeof weight !== 'number') continue;
    values.push([key, weight]);
    const reason = value['reason'];
    marks.push({ list: listPath, unit: key, ...(typeof reason === 'string' ? { reason } : {}) });
  }
  if (problems.length > 0) return err(unitProblemsError(listPath, problems, UnitEntryForm.WeightMap));
  // `fromEntries` defines own properties, so a key like `__proto__` stays a key.
  return ok({ values: Object.fromEntries(values), marks });
}
