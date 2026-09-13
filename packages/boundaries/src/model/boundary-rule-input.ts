import type { SelectorListEntry } from '@shrkcrft/core';
import type { IBoundaryRule } from './boundary-rule.ts';

/**
 * A boundary rule as AUTHORED (round 13). The four selector lists accept an
 * `expectEmpty` marker beside plain strings — spec 13.1's own syntax:
 *
 *   forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }]
 *
 * The loader validates it (`validateBoundaryRule`) and normalises it
 * (`normalizeBoundaryRule`) into the LOADED {@link IBoundaryRule}: the plain
 * string lists every reader already consumes, plus the `expectEmptyUnits`
 * ledger — derived, never authored. Its keys are the only keys a rule may
 * carry (`BOUNDARY_RULE_INPUT_KEYS`). `exceptions[].target` stays a string: a
 * stale exception is an error by design.
 */
export interface IBoundaryRuleInput
  extends Omit<IBoundaryRule, 'from' | 'forbiddenImports' | 'allowedImports' | 'exemptFiles' | 'expectEmptyUnits'> {
  /** Scope globs; an entry starting with `!` exempts. A marker: `{ pattern: 'packages/plugin-react/**', expectEmpty: true }`. */
  from: readonly SelectorListEntry[];
  forbiddenImports?: readonly SelectorListEntry[];
  allowedImports?: readonly SelectorListEntry[];
  exemptFiles?: readonly SelectorListEntry[];
}
