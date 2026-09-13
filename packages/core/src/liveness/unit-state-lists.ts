import { formatUnitLiveness } from './format-unit-liveness.ts';
import type { ISettledUnitLiveness } from './i-settled-unit-liveness.ts';
import type { IUnitLiveness } from './i-unit-liveness.ts';
import type { IUnitStateLists } from './i-unit-state-lists.ts';

/**
 * A settle's dead / intended-empty / went-live units as their one printed line
 * each (list-qualified, causes left to the surface's footer) — THE builder of
 * `rules[].units`, so JSON consumers read the same sentences the text prints.
 */
export function unitStateLists(
  settled: Pick<ISettledUnitLiveness, 'dead' | 'intendedEmpty' | 'wentLive'>,
): IUnitStateLists {
  const line = (u: IUnitLiveness): string => formatUnitLiveness(u, { list: true, causes: false });
  return {
    dead: settled.dead.map(line),
    intendedEmpty: settled.intendedEmpty.map(line),
    wentLive: settled.wentLive.map(line),
  };
}
