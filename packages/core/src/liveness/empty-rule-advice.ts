/**
 * THE advice printed under a rule that matched nothing (round 13) — it replaces
 * five contradictory `failOnEmpty` advice literals that told the same rule to
 * set opposite values. `formatEmptyRuleAdvice` appends the failOnEmpty advice
 * only where it applies.
 */
export const EMPTY_RULE_ADVICE =
  'Fix the selector — or, if its target does not exist yet, mark the unit { pattern, expectEmpty: true }';
