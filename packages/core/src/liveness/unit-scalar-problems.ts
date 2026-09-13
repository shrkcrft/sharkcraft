import { normalizeUnitScalar } from './normalize-unit-scalar.ts';
import { unitProblemsOf } from './unit-problems-of.ts';

/** `normalizeUnitScalar`'s refusals as problem sentences (`<listPath>: …`), or `[]` — for validators. */
export function unitScalarProblems(value: unknown, listPath: string): readonly string[] {
  const r = normalizeUnitScalar(value, listPath);
  return r.ok ? [] : unitProblemsOf(r.error);
}
