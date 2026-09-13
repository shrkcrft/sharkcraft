import type { IWiringSourceInput } from './i-wiring-source-input.ts';
import type { IRegistrationIdiom } from './registration-idiom.ts';

/** The AUTHORED registration idiom (round 13): each role takes the markable {@link IWiringSourceInput}. */
export interface IRegistrationIdiomInput extends Omit<IRegistrationIdiom, 'declared' | 'provided' | 'consumed'> {
  readonly declared: IWiringSourceInput;
  readonly provided: IWiringSourceInput;
  readonly consumed: IWiringSourceInput;
}
