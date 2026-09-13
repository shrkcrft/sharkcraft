import type { IWiringSourceInput } from './i-wiring-source-input.ts';
import type { IWiringRule } from './wiring-rule.ts';

/** The AUTHORED wiring rule (round 13): every source takes the markable {@link IWiringSourceInput}. */
export interface IWiringRuleInput extends Omit<IWiringRule, 'declared' | 'registered' | 'chain'> {
  readonly declared?: IWiringSourceInput;
  readonly registered?: IWiringSourceInput | readonly IWiringSourceInput[];
  readonly chain?: readonly IWiringSourceInput[];
}
