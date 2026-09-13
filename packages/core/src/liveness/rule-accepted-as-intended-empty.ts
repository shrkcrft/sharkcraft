import type { IVerdictCoverage } from '../verdict/verdict-coverage.ts';
import { ExpectEmptyAcceptedBy } from './expect-empty-accepted-by.ts';

/**
 * THE "accepted as intended-empty" predicate over a rule result (round 13, K6):
 * the rule's PRIMARY coverage record IS its `expectEmpty` acceptance (settle
 * record B, `acceptedBy: 'expectEmpty'`) and it examined 0 units. That is
 * exactly the record `settleRuleEmptiness` hands back as the rule's coverage
 * when it settles `RuleEmptiness.IntendedEmpty` (every inclusion unit of the
 * primary list marked, no file matched), and every plane producer puts it on
 * the rule as `coverage` — so the envelope reads the engines' own settle, never
 * a per-verb re-derivation.
 *
 * Such a rule ran no comparison: it is ACCEPTED, never "evaluated". The gate
 * envelope (`buildGateEnvelope`) counts it apart from `evaluated`, and a
 * renderer prints `N evaluated, M accepted as intended-empty`.
 *
 * Deliberately NOT accepted-empty:
 *   - a rule that examined live units BESIDE its planned ones (its acceptance
 *     rides as `unitAcceptance`, its coverage is the live record — e.g. a
 *     registration idiom whose declared role is planned while its provided and
 *     consumed roles are read);
 *   - the baselines rule-level fence (`acceptedBy: 'expectEmpty: true'`,
 *     `RuleEmptiness.AssertedEmptyOutput`): it examined live inputs and asserts
 *     the OUTPUT is empty — a real comparison.
 */
export function ruleAcceptedAsIntendedEmpty(rule: { readonly coverage?: IVerdictCoverage | undefined }): boolean {
  const coverage = rule.coverage;
  return coverage !== undefined && coverage.acceptedBy === ExpectEmptyAcceptedBy.Unit && coverage.examined === 0;
}
