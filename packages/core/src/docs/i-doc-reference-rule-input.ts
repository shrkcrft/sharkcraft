import type { SelectorListEntry } from '../liveness/selector-list-entry.ts';
import type { IDocReferenceRule } from './doc-reference-rule.ts';

/** The AUTHORED doc-reference rule (round 13): `files` takes a glob or `{ pattern, expectEmpty: true, reason? }`. */
export interface IDocReferenceRuleInput extends Omit<IDocReferenceRule, 'files' | 'expectEmptyUnits'> {
  readonly files: readonly SelectorListEntry[];
}
