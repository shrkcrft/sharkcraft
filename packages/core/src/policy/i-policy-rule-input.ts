import type { SelectorListEntry } from '../liveness/selector-list-entry.ts';
import type { IPolicyRule } from './policy-rule.ts';

/** The AUTHORED policy rule (round 13): `files` takes a glob or `{ pattern, expectEmpty: true, reason? }`. */
export interface IPolicyRuleInput extends Omit<IPolicyRule, 'files' | 'expectEmptyUnits'> {
  readonly files?: readonly SelectorListEntry[];
}
