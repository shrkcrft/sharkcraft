import type { IUnitMark } from '../liveness/i-unit-mark.ts';
import { mergeUnitMarks } from '../liveness/merge-unit-marks.ts';
import { normalizeUnitList } from '../liveness/normalize-unit-list.ts';
import type { AppErrorImpl } from '../result/errors.ts';
import { ok, type Result } from '../result/result.ts';

/**
 * ONE rule-level markable list of a gate rule — a policy / doc-reference
 * rule's `files`, a generated rule's `generatedGlob`, a baseline's
 * `watchFiles` — through core's one parser (round 13): the list becomes the
 * plain units, each `{ pattern, expectEmpty: true }` entry a mark (`list:
 * field`) merged into the rule's `expectEmptyUnits`.
 *
 * THE normaliser for these lists: the config loader and the pack merge seam
 * reach it through `normalizePlaneRule`, and the plane engines
 * (`runPolicyLint` / `evaluatePolicy`, `checkDocReferences`, the generated
 * scan) call it at entry. IDEMPOTENT and identity-preserving: a rule whose
 * list is already plain strings comes back as the SAME object, so an engine's
 * per-rule memo still hits. An absent list is left absent.
 */
export function normalizeRuleList<T extends { readonly expectEmptyUnits?: readonly IUnitMark[] }>(
  rule: T,
  field: keyof T & string,
): Result<T, AppErrorImpl> {
  const raw = rule[field] as unknown;
  if (raw === undefined) return ok(rule);
  const n = normalizeUnitList(raw as readonly unknown[], field);
  if (!n.ok) return n;
  if (n.value.marks.length === 0 && (raw as readonly unknown[]).every((e) => typeof e === 'string')) return ok(rule);
  return ok({ ...rule, [field]: n.value.units, expectEmptyUnits: mergeUnitMarks(rule.expectEmptyUnits, n.value.marks) });
}
