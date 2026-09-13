import type { IUnitMark } from './i-unit-mark.ts';
import type { IUnitObservation } from './i-unit-observation.ts';
import type { UnitDeadWeight } from './unit-dead-weight.ts';

/** One settle: every unit a rule (or asset doctor run) judged, plus its marker ledger. */
export interface IUnitLivenessInput {
  /** Whose units these are (a rule id, `registration hints`) — set as the coverage records' `subject`. */
  readonly subject?: string;
  /** What one Coverage-weight unit is, plural (`scope globs`, `discovery selectors`) — record A's unit, and record B's unless {@link acceptanceUnitLabel}. */
  readonly unitLabel: string;
  /** Record B's unit when one settle spans lists of different kinds (`selector units`). */
  readonly acceptanceUnitLabel?: string;
  /** The default weight of every observation (an observation's own `weight` overrides it). */
  readonly weight: UnitDeadWeight;
  /** One row per unit judged — every unit of every markable list the rule owns, marked or not. */
  readonly observations: readonly IUnitObservation[];
  /** The ledger: the loaded element's `expectEmptyUnits` (qualified like the observations). */
  readonly marks: readonly IUnitMark[];
  /** Record A's reason, in the plane's existing words (`reached no governed file among 4 scanned`). Default `matched nothing`. */
  readonly deadSummary?: string;
  /** True when a cap stopped the scan: record A is `capped` — never clean, never acceptable. */
  readonly capped?: boolean;
  /** Record A's reason when {@link capped} (`a discovery walk hit its 5000-directory cap`). */
  readonly cappedReason?: string;
}
