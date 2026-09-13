import type { SelectorListEntry } from '../liveness/selector-list-entry.ts';
import type { IBaselineRule } from './baseline-rule.ts';
import type { IBaselineComputeInput } from './i-baseline-compute-input.ts';

/**
 * The AUTHORED baseline rule (round 13): `watchFiles` and the extractor
 * compute's `source.files` take a glob or `{ pattern, expectEmpty: true,
 * reason? }`. The rule-level `expectEmpty: boolean` (the fence's OUTPUT
 * assertion) is unchanged.
 */
export interface IBaselineRuleInput extends Omit<IBaselineRule, 'compute' | 'watchFiles' | 'expectEmptyUnits'> {
  readonly compute: IBaselineComputeInput;
  readonly watchFiles?: readonly SelectorListEntry[];
}
