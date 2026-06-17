import type { IAlignmentMap } from './alignment-map.ts';

/** The outcome of an alignment pass. */
export interface IAlignmentResult {
  /** Text with volatile tokens replaced by stable placeholders. */
  aligned: string;
  /** The (new) alignment map — pass it back next turn to keep ordinals stable. */
  map: IAlignmentMap;
  /** Number of token occurrences replaced. */
  replaced: number;
}
