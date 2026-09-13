import { unitStateLists, type ISettledUnitLiveness, type IUnitStateLists } from '@shrkcrft/core';

/**
 * The printed unit lines (`dead` / `intendedEmpty` / `wentLive`, each THE one
 * `formatUnitLiveness` line) of several settles at once — an asset doctor
 * settles more than one list (scaffold globs and patterns; search-tuning keys
 * and task hints) and its `--json` carries one `units` object (round 13).
 */
export function settledUnitStates(
  settles: readonly Pick<ISettledUnitLiveness, 'dead' | 'intendedEmpty' | 'wentLive'>[],
): IUnitStateLists {
  return unitStateLists({
    dead: settles.flatMap((s) => s.dead),
    intendedEmpty: settles.flatMap((s) => s.intendedEmpty),
    wentLive: settles.flatMap((s) => s.wentLive),
  });
}
