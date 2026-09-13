import { normalizeUnitList } from './normalize-unit-list.ts';
import { unitProblemsOf } from './unit-problems-of.ts';

/**
 * `normalizeUnitList`'s refusals as problem sentences (`<listPath>[i]: …`), or
 * `[]` when the list is well formed — the entry point for a zod `superRefine`
 * and the asset validators, so no validator re-implements the marker shape.
 */
export function unitListProblems(list: readonly unknown[], listPath: string): readonly string[] {
  const r = normalizeUnitList(list, listPath);
  return r.ok ? [] : unitProblemsOf(r.error);
}
