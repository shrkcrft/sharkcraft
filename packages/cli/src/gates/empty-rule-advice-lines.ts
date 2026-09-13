import { formatEmptyRuleAdvice } from '@shrkcrft/core';

/**
 * THE empty-rule advice a plane verb prints under the rules that matched
 * nothing (round 13) — one sentence per `fails` value present, each from core's
 * `formatEmptyRuleAdvice` with the rule's REAL `fails`: a failing rule is never
 * told to set `failOnEmpty: true`, a soft one never told to set it `false`.
 *
 * Every plane verb's skip listing calls it — `check wiring`, `policy-lint`
 * (their 0-evaluated early returns included), `gates coverage`, `baseline
 * check`, `generated check`, `docs references check` — so no branch drops the
 * advice, and no verb words it twice.
 */
export function emptyRuleAdviceLines(rules: readonly { readonly fails: boolean }[]): string[] {
  const out: string[] = [];
  if (rules.some((r) => r.fails)) out.push(formatEmptyRuleAdvice({ fails: true }));
  if (rules.some((r) => !r.fails)) out.push(formatEmptyRuleAdvice({ fails: false }));
  return out;
}
