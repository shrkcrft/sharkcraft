import type { IExpectEmptyEntry } from './i-expect-empty-entry.ts';

/**
 * One AUTHORED entry of a markable selector list (and the authored form of the
 * scalar `discovery.targetFile`): the plain unit, or the unit marked
 * `expectEmpty`. Authored `*Input` types widen their markable fields to this;
 * loaded types keep `string`.
 */
export type SelectorListEntry = string | IExpectEmptyEntry;
