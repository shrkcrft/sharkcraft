import type { IBoundaryRuleInput } from './boundary-rule-input.ts';

/**
 * Every key an authored boundary rule may carry — derived from
 * {@link IBoundaryRuleInput} by type: the Record must name each key of the
 * interface and no other, so a rule field added without listing it here fails
 * tsc. `validateBoundaryRule` refuses any other key (round 13): an unknown key
 * used to load and be silently ignored — a guessed rule-level `expectEmpty`
 * among them, which switched nothing off while reading as if it had.
 */
export const BOUNDARY_RULE_INPUT_KEYS: Readonly<Record<keyof IBoundaryRuleInput, true>> = {
  id: true,
  title: true,
  description: true,
  severity: true,
  from: true,
  forbiddenImports: true,
  forbiddenMatch: true,
  allowedImports: true,
  failOnEmpty: true,
  exemptFiles: true,
  excludeTests: true,
  exceptions: true,
  tags: true,
  appliesWhen: true,
  message: true,
  suggestedFix: true,
  relatedRules: true,
  relatedPathConventions: true,
  references: true,
};
