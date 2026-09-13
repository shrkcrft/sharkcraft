/**
 * Does this rule carry the baselines rule-level fence (`expectEmpty: true`)?
 * The ONE read of a rule's `expectEmpty` outside the config schema and the
 * baseline rule view — every emptiness site passes the answer to
 * `settleRuleEmptiness` as `assertsEmptyOutput` rather than consulting the
 * field itself (an r77 grep lock).
 */
export function ruleAssertsEmptyOutput(rule: { readonly expectEmpty?: boolean }): boolean {
  return rule.expectEmpty === true;
}
