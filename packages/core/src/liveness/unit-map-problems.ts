import { normalizeUnitMap } from './normalize-unit-map.ts';
import { unitProblemsOf } from './unit-problems-of.ts';

/** `normalizeUnitMap`'s refusals as problem sentences (`<listPath>["<key>"]: …`), or `[]` — for validators. */
export function unitMapProblems(record: unknown, listPath: string): readonly string[] {
  const r = normalizeUnitMap(record, listPath);
  return r.ok ? [] : unitProblemsOf(r.error);
}
