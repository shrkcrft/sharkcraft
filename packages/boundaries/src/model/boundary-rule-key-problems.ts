import { nearestIds } from '@shrkcrft/core';
import type { IBoundaryRuleValidationIssue } from './boundary-rule.ts';
import { BOUNDARY_RULE_INPUT_KEYS } from './boundary-rule-input-keys.ts';

/**
 * Rule-level spellings of "this rule may match nothing" an author carries over
 * from another plane (baselines' rule-level `expectEmpty`), or from a guess —
 * plus the derived ledger, which no author may write.
 */
const RULE_LEVEL_MARKER_KEYS: ReadonlySet<string> = new Set(['expectEmpty', 'allowDead', 'intendedEmpty', 'expectEmptyUnits']);

/** THE words for a rule-level marker (DECISIONS §4). */
const PER_PATTERN = 'expectEmpty is per pattern on a boundary rule: forbiddenImports: [{ pattern, expectEmpty: true }]';

const KNOWN_KEYS: readonly string[] = Object.keys(BOUNDARY_RULE_INPUT_KEYS);

/**
 * One issue per key an authored boundary rule may not carry (round 13): a
 * rule-level `expectEmpty` / `allowDead` / `intendedEmpty` (the marker is per
 * pattern), the derived `expectEmptyUnits` ledger, or any other key that is
 * not an {@link BOUNDARY_RULE_INPUT_KEYS} key — with a did-you-mean through
 * the repo's ONE scorer (`nearestIds`, `@shrkcrft/core`). A misplaced key used to
 * load and be silently ignored.
 */
export function boundaryRuleKeyProblems(rule: Readonly<Record<string, unknown>>): IBoundaryRuleValidationIssue[] {
  const issues: IBoundaryRuleValidationIssue[] = [];
  for (const key of Object.keys(rule)) {
    if (Object.prototype.hasOwnProperty.call(BOUNDARY_RULE_INPUT_KEYS, key)) continue;
    if (RULE_LEVEL_MARKER_KEYS.has(key)) {
      issues.push({ field: key, message: PER_PATTERN });
      continue;
    }
    const near = nearestIds(key, KNOWN_KEYS, 1)[0];
    issues.push({
      field: key,
      message: `unknown key '${key}' — not a boundary rule field, so it would be silently ignored${near !== undefined ? `; did you mean '${near.id}'?` : ''}`,
    });
  }
  return issues;
}
