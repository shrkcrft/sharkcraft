import { EMPTY_RULE_ADVICE } from './empty-rule-advice.ts';

/**
 * {@link EMPTY_RULE_ADVICE} plus the failOnEmpty advice that APPLIES to this
 * rule — never "set failOnEmpty: true" to a rule that already fails on empty:
 *
 *   - a soft skip (exit 2): … — or set `failOnEmpty: true` once the rule is known to have real subjects;
 *   - a failing skip (exit 1): … — or, if the set may legitimately be empty, set `failOnEmpty: false`.
 *
 * Pass the settled emptiness (`ISettledRuleEmptiness`) or `{ fails }`.
 */
export function formatEmptyRuleAdvice(emptiness: { readonly fails: boolean }): string {
  return emptiness.fails
    ? `${EMPTY_RULE_ADVICE} — or, if the set may legitimately be empty, set \`failOnEmpty: false\` (it then reports NOT VERIFIED, never a pass)`
    : `${EMPTY_RULE_ADVICE} — or set \`failOnEmpty: true\` once the rule is known to have real subjects (an empty match then fails)`;
}
