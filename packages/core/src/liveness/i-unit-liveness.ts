import type { IUnitMark } from './i-unit-mark.ts';
import type { IUnitObservation } from './i-unit-observation.ts';
import type { UnitDeadWeight } from './unit-dead-weight.ts';
import type { UnitLivenessState } from './unit-liveness-state.ts';

/** One unit after the settle: the observation, its state, and the ONE sentence every surface prints for it. */
export interface IUnitLiveness extends IUnitObservation {
  readonly state: UnitLivenessState;
  /** The resolved weight (the observation's own, else the settle's default). */
  readonly weight: UnitDeadWeight;
  /** The resolved label (see `IUnitObservation.label`). */
  readonly label: string;
  /** True when a marker was HONOURED (a cause-bearing unit's marker is ignored). */
  readonly marked: boolean;
  /** The marker, when the ledger holds one for this unit — honoured or ignored. */
  readonly mark?: IUnitMark;
  /**
   * Known to contribute: Live, or WentLive with `live === true`. A went-live
   * unit that is NOT effective (its target exists, but every match is exempt or
   * excluded, or unproven) keeps its dead weight: it is a gap in record A and
   * never turns a 2 into a 0.
   */
  readonly effective: boolean;
  /** The state sentence, without the unit (`formatUnitLiveness` prefixes the label). */
  readonly message: string;
}
