import { isNegatedGlob, UnitDeadWeight, type IUnitLivenessInput, type IUnitObservation } from '@shrkcrft/core';
import type { IGlobLivenessRequest } from './i-glob-liveness-request.ts';

/**
 * THE observation predicate for a gate-plane glob unit (round 13). Every
 * gate-plane reporter — `gates coverage` / `gates try` / `quality`
 * (`buildGateCoverage`), `policy-lint` (`runPolicyLint`), and each plane
 * engine's rule-emptiness check (`settleGlobLists`) — builds its core
 * `settleUnitLiveness` input here, so a glob and its marker are read one way
 * everywhere:
 *
 *   unit                                  | exists | live
 *   --------------------------------------+--------+------
 *   inclusion glob, not dead              | yes    | yes   (`it now matches N file(s)`)
 *   inclusion glob, dead, matched > 0     | yes    | no    (every match excluded by the list's own negations)
 *   inclusion glob, dead, matched 0       | no     | no    (its target does not exist)
 *   negation that excludes a file         | yes    | yes
 *   negation that excludes nothing        | no     | no
 *
 * `exists` is RAW target existence — it decides a MARKED unit (intended-empty,
 * or went-live), so an acceptance never says "does not exist yet" about a glob
 * whose files exist but are all excluded. `live` is the one dead-unit decision
 * (`globListUnits`) negated — it decides an unmarked unit, and whether a
 * went-live unit is effective. A glob in front of an unread file is not dead
 * (`globListUnits`), so it reads live, never intended-empty.
 *
 * Advisory weight: a dead gate glob is listed and withholds the ✓, it moves
 * the exit only under `--fail-on-dead-units`; record B (the acceptance) is
 * emitted for any intended-empty unit.
 */
export function globListLivenessInput(request: IGlobLivenessRequest): IUnitLivenessInput {
  const observations: IUnitObservation[] = [];
  for (const l of request.lists) {
    const deadBy = new Map(l.units.dead.map((d) => [d.glob, d] as const));
    const excludes = new Map(l.units.negations.map((n) => [n.glob, n.excludes] as const));
    const effective = new Map((l.units.measures ?? []).map((m) => [m.glob, m.effective] as const));
    for (const glob of new Set(l.globs)) {
      const dead = deadBy.get(glob);
      const negation = isNegatedGlob(glob);
      const exists = dead === undefined || (!dead.negation && dead.matched > 0);
      const live = dead === undefined;
      const count = negation ? excludes.get(glob) : live ? effective.get(glob) : dead?.matched;
      const liveBecause = !exists
        ? undefined
        : negation
          ? `it now excludes ${count ?? 'a'} file${count === 1 || count === undefined ? '' : 's'}`
          : `it now matches ${count ?? 'a'} file${count === 1 || count === undefined ? '' : 's'}`;
      observations.push({
        list: l.list,
        unit: glob,
        label: l.label !== undefined ? `${l.label}: ${glob}` : glob,
        exists,
        live,
        ...(dead !== undefined ? { matched: dead.matched, deadReason: dead.reason } : {}),
        ...(liveBecause !== undefined ? { liveBecause } : {}),
      });
    }
  }
  return {
    ...(request.subject !== undefined ? { subject: request.subject } : {}),
    unitLabel: 'globs',
    weight: UnitDeadWeight.Advisory,
    observations,
    marks: request.marks,
    deadSummary: 'select or exclude nothing',
  };
}
