import type { AppErrorImpl } from '../result/errors.ts';
import { err, ok, type Result } from '../result/result.ts';
import { describeEntryValue } from './describe-entry-value.ts';
import type { IUnitScalar } from './i-unit-scalar.ts';
import { isMarkerObject } from './is-marker-object.ts';
import { markerEntryProblems } from './marker-entry-problems.ts';
import { unitProblemsError } from './unit-problems-error.ts';
import { UnitEntryForm } from './unit-entry-form.ts';

/**
 * THE parser for a markable SCALAR selector (registration hint
 * `discovery.targetFile`): `string | { pattern, expectEmpty: true, reason? }`
 * in, the plain unit plus its ledger (0 or 1 mark) out.
 *
 *   normalizeUnitScalar({ pattern: 'src/app/routes.ts', expectEmpty: true }, 'discovery.targetFile')
 *   → ok({ unit: 'src/app/routes.ts', marks: [{ list: 'discovery.targetFile', unit: 'src/app/routes.ts' }] })
 *
 * Refusals are `<listPath>: …` problems (no index), with the same marker rules
 * as a list entry. Idempotent: a string returns `{ unit, marks: [] }`. Only
 * call it when the scalar is present — absence is the asset validator's call.
 */
export function normalizeUnitScalar(value: unknown, listPath: string): Result<IUnitScalar, AppErrorImpl> {
  if (typeof value === 'string') return ok({ unit: value, marks: [] });
  if (!isMarkerObject(value)) {
    return err(
      unitProblemsError(
        listPath,
        [`${listPath}: must be a string or { pattern, expectEmpty: true, reason? } (got ${describeEntryValue(value)})`],
        UnitEntryForm.Scalar,
      ),
    );
  }
  const own = markerEntryProblems(value, UnitEntryForm.Scalar);
  const pattern = value['pattern'];
  if (own.length > 0 || typeof pattern !== 'string') {
    return err(unitProblemsError(listPath, own.map((p) => `${listPath}: ${p}`), UnitEntryForm.Scalar));
  }
  const reason = value['reason'];
  return ok({
    unit: pattern,
    marks: [{ list: listPath, unit: pattern, ...(typeof reason === 'string' ? { reason } : {}) }],
  });
}
