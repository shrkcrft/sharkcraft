import type { AppErrorImpl } from '../result/errors.ts';
import { err, ok, type Result } from '../result/result.ts';
import { describeEntryValue } from './describe-entry-value.ts';
import type { IUnitList } from './i-unit-list.ts';
import type { IUnitMark } from './i-unit-mark.ts';
import { isMarkerObject } from './is-marker-object.ts';
import { markerEntryProblems } from './marker-entry-problems.ts';
import { unitProblemsError } from './unit-problems-error.ts';
import { UnitEntryForm } from './unit-entry-form.ts';

/**
 * THE parser for a markable selector list (round 13): authored entries
 * `string | { pattern, expectEmpty: true, reason? }` in, the PLAIN string list
 * every reader already consumes plus the marker ledger out.
 *
 *   normalizeUnitList(['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }], 'forbiddenImports')
 *   → ok({ units: ['@scope/kernel-*', '@scope/plugin-react'],
 *          marks: [{ list: 'forbiddenImports', unit: '@scope/plugin-react' }] })
 *
 * - A string passes through untouched (a `!` negation included; plain
 *   duplicates stay legal and stay in `units`).
 * - An object must be a well-formed marker (`markerEntryProblems`); its
 *   `pattern` joins `units` in place and a mark joins the ledger.
 * - Refused, each as a `<listPath>[i]: …` problem, all reported at once: a
 *   non-string non-object entry; a marker naming no unit; `expectEmpty` other
 *   than `true`; an unknown key (did-you-mean); an empty or non-string
 *   `reason`; the same unit MARKED twice in one list.
 *
 * IDEMPOTENT: a plain list returns `{ units: list, marks: [] }`, so an engine
 * normalises defensively at entry and a hand-built rule never crashes on an
 * object. The `!` shape rules (`globListProblem`, `exemptionListProblem`) run
 * on the returned `units`, so `{ pattern: '!' }` is refused exactly like `'!'`.
 * Loaders stamp pack provenance with `stampUnitMarks`.
 */
export function normalizeUnitList(list: readonly unknown[], listPath: string): Result<IUnitList, AppErrorImpl> {
  if (!Array.isArray(list)) {
    return err(
      unitProblemsError(
        listPath,
        [`${listPath}: must be a list of strings or { pattern, expectEmpty: true, reason? } entries (got ${describeEntryValue(list)})`],
        UnitEntryForm.List,
      ),
    );
  }
  const units: string[] = [];
  const marks: IUnitMark[] = [];
  const problems: string[] = [];
  const markedAt = new Map<string, number>();
  list.forEach((entry: unknown, index: number) => {
    const at = `${listPath}[${index}]`;
    if (typeof entry === 'string') {
      units.push(entry);
      return;
    }
    if (!isMarkerObject(entry)) {
      problems.push(`${at}: must be a string or { pattern, expectEmpty: true, reason? } (got ${describeEntryValue(entry)})`);
      return;
    }
    const own = markerEntryProblems(entry, UnitEntryForm.List);
    if (own.length > 0) {
      for (const p of own) problems.push(`${at}: ${p}`);
      return;
    }
    const pattern = entry['pattern'];
    if (typeof pattern !== 'string') return;
    const first = markedAt.get(pattern);
    if (first !== undefined) {
      problems.push(`${at}: '${pattern}' is already marked expectEmpty at ${listPath}[${first}] — mark a unit once`);
      return;
    }
    markedAt.set(pattern, index);
    units.push(pattern);
    const reason = entry['reason'];
    marks.push({ list: listPath, unit: pattern, ...(typeof reason === 'string' ? { reason } : {}) });
  });
  if (problems.length > 0) return err(unitProblemsError(listPath, problems, UnitEntryForm.List));
  return ok({ units, marks });
}
