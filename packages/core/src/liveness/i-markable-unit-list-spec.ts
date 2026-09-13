import type { MarkableListOwner } from './markable-list-owner.ts';
import type { UnitDeadWeight } from './unit-dead-weight.ts';
import type { UnitEntryForm } from './unit-entry-form.ts';
import type { UnitPolarity } from './unit-polarity.ts';

/** One markable list: where it lives, what carries its ledger, and how its units weigh. */
export interface IMarkableUnitListSpec {
  /** Where an author writes the list (`boundary rule`, `wiringRules[].declared`, `registration hint`). */
  readonly container: string;
  /** The LOADED type that carries the list's `expectEmptyUnits` ledger. */
  readonly carrier: string;
  /**
   * The list's path relative to the carrier — THE string passed to the
   * normaliser as `listPath`, stored as `IUnitMark.list`, and used as
   * `IUnitObservation.list` by the reporter. `[i]` stands for an array index
   * (`indexListPath`).
   */
  readonly listPath: string;
  readonly form: UnitEntryForm;
  /** Which entries of the list this spec covers (the boundary `from` list weighs its `!` exemptions differently). */
  readonly polarity: UnitPolarity;
  /** How a dead unit of this list weighs on the verdict. */
  readonly weight: UnitDeadWeight;
  /** What one unit is, plural, as coverage records name it. */
  readonly unitLabel: string;
  /** The reporter's existing liveness predicate — what flips a marked unit to went-live (docs + census wording). */
  readonly wentLive: string;
  /** The subsystem whose reporter judges the list. */
  readonly owner: MarkableListOwner;
}
