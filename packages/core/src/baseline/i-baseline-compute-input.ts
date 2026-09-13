import type { IWiringSourceInput } from '../wiring/i-wiring-source-input.ts';
import type { IBaselineCompute } from './baseline-rule.ts';

/** The AUTHORED baseline compute (round 13): an extractor `source` takes the markable {@link IWiringSourceInput}. */
export interface IBaselineComputeInput extends Omit<IBaselineCompute, 'source'> {
  readonly source?: IWiringSourceInput;
}
