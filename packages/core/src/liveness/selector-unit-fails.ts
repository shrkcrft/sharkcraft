import type { ISelectorUnitFailOptions } from './i-selector-unit-fail-options.ts';
import type { IUnitLiveness } from './i-unit-liveness.ts';
import { UnitLivenessState } from './unit-liveness-state.ts';

/**
 * THE predicate every `--fail-on-dead-units` consumer calls: does this settled
 * unit fail the run (exit 1)?
 *
 *   state                       | fails when
 *   ----------------------------+------------------------------------------------------------
 *   Dead                        | failOnDeadUnits
 *   WentLive, local marker      | failOnDeadUnits, or strict where strict promotes warnings
 *   WentLive, pack marker       | never — printed as INFO (the consumer cannot edit it)
 *   IntendedEmpty/Live/Unproven | never (an explicit valve is not a warning; the read gap vetoes on its own)
 *
 * Exit 2 is not this predicate's business: a Coverage-weight gap reaches it
 * through record A, whatever the flags.
 */
export function selectorUnitFails(
  unit: Pick<IUnitLiveness, 'state' | 'mark'>,
  options: ISelectorUnitFailOptions,
): boolean {
  if (unit.state === UnitLivenessState.Dead) return options.failOnDeadUnits;
  if (unit.state !== UnitLivenessState.WentLive) return false;
  if (unit.mark?.packageName !== undefined) return false;
  return options.failOnDeadUnits || (options.strict && options.strictPromotesWarnings);
}
