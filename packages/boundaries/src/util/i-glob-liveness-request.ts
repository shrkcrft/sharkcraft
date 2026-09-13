import type { IUnitMark } from '@shrkcrft/core';
import type { IGlobLivenessList } from './i-glob-liveness-list.ts';

/** Every glob list one gate rule reads, and its markers — the input of the one gate-plane glob settle (round 13). */
export interface IGlobLivenessRequest {
  /** The rule id; it becomes the coverage records' `subject`. */
  readonly subject?: string;
  readonly lists: readonly IGlobLivenessList[];
  /** The rule's / sources' `expectEmptyUnits`, qualified exactly like the lists' `list`. */
  readonly marks: readonly IUnitMark[];
}
