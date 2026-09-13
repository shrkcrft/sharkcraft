import type { IExpectEmptyWeightEntry } from './i-expect-empty-weight-entry.ts';

/**
 * One AUTHORED value of a boost map: the plain weight, or a weight marked
 * `expectEmpty`. Authored `*Input` types widen their boost maps to
 * `Record<string, SelectorWeightEntry>`; loaded types keep `Record<string, number>`.
 */
export type SelectorWeightEntry = number | IExpectEmptyWeightEntry;
