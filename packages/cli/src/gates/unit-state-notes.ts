import {
  DEAD_SELECTOR_CAUSES,
  formatUnitLiveness,
  UnitLivenessState,
  type IUnitLiveness,
} from '@shrkcrft/core';
import type { IUnitStateNoteRow } from './i-unit-state-note-row.ts';
import type { IUnitStateNotes } from './i-unit-state-notes.ts';

/** Options for {@link unitStateNotes}. */
interface IUnitStateNotesOptions {
  /**
   * The verb's `--fail-on-dead-units` value, when the verb TAKES the flag
   * (`undefined` = it does not, so no "pass --fail-on-dead-units" hint).
   */
  readonly failOnDeadUnits?: boolean;
  /**
   * Also list every INTENDED-EMPTY unit (round 13, K6), each as its one
   * per-unit line under a neutral bullet — never a ✓ (the acceptance belongs to
   * the settled verdict). The explain views opt in: an introspection names
   * every unit state. The verbs do not; their acceptance line carries it.
   */
  readonly intendedEmpty?: boolean;
}

interface IPicked {
  readonly id: string;
  readonly u: IUnitLiveness;
}

/**
 * THE unit-state block every plane verb prints (round 13, K2) — the one
 * renderer, so `policy-lint`, `check wiring`, `baseline check`, `generated
 * check`, `docs references check`, `registry <name> list|duplicates`, `gates
 * check`, the explain surfaces and finish's plane sub-gates say about a
 * selector unit exactly what `gates coverage` and `check boundaries` say:
 *
 *   - an unmarked DEAD unit of a rule that is not already reported as matching
 *     nothing (a dead import-edges `to.files` under an accepted fence
 *     included) — advisory: listed, the ✓ withheld, the exit unchanged, with
 *     ONE footer carrying `DEAD_SELECTOR_CAUSES`;
 *   - a LOCAL `expectEmpty` marker whose target appeared (went live) — the
 *     fence is a stale assertion: listed, the ✓ withheld;
 *   - a PACK marker that went live — INFO in its own block, never a failure
 *     and never withholding the ✓ (the consumer cannot edit it).
 *
 * Each line is `• <rule id>: <formatUnitLiveness(u)>` — the one per-unit line;
 * a surface adds decoration only, never its own state words. The verb reads
 * `stale` to qualify its clean line (`qualifyCleanForUnits`).
 */
export function unitStateNotes(
  rows: readonly IUnitStateNoteRow[],
  options: IUnitStateNotesOptions = {},
): IUnitStateNotes {
  const pick = (state: UnitLivenessState, keep: (u: IUnitLiveness, r: IUnitStateNoteRow) => boolean): IPicked[] =>
    rows.flatMap((r) =>
      (r.unitLiveness ?? []).filter((u) => u.state === state && keep(u, r)).map((u) => ({ id: r.id, u })),
    );
  const dead = pick(UnitLivenessState.Dead, (_u, r) => r.reportedEmpty !== true);
  const local = pick(UnitLivenessState.WentLive, (u) => u.mark?.packageName === undefined);
  const pack = pick(UnitLivenessState.WentLive, (u) => u.mark?.packageName !== undefined);
  const intended = options.intendedEmpty === true ? pick(UnitLivenessState.IntendedEmpty, () => true) : [];
  const unitLine = (x: IPicked): string => `${x.id}: ${formatUnitLiveness(x.u, { causes: false })}`;
  const line = (x: IPicked): string => `  • ${unitLine(x)}\n`;
  let text = '';
  if (dead.length > 0) {
    text += `\nDead selector units (${dead.length}) — each matches nothing, so it enforces nothing:\n`;
    text += dead.map(line).join('');
    // The causes ONCE, as a footer (`formatUnitLiveness(u, { causes: false })`
    // on each line) — the wording `check boundaries` appends to each unit.
    text += `  Dead selectors: ${DEAD_SELECTOR_CAUSES}.\n`;
    if (options.failOnDeadUnits === false) text += '  Pass --fail-on-dead-units to fail the run on them.\n';
  }
  if (local.length > 0) {
    text += `\nexpectEmpty markers that went live (${local.length}) — each fence now has a target; remove the marker:\n`;
    text += local.map(line).join('');
  }
  if (pack.length > 0) {
    text +=
      `\nINFO — pack expectEmpty markers that went live (${pack.length}) — the fence now has a target; ` +
      "the pack's author removes the marker, and it never fails this run:\n";
    text += pack.map(line).join('');
  }
  if (intended.length > 0) {
    // A neutral bullet, never a ✓: the acceptance and its ✓ belong to the
    // settled verdict (`verdictLine`, exit 0 only) — the same decoration
    // `gates coverage` and `gates try` give an intended-empty unit.
    text += `\nIntended-empty selector units (${intended.length}) — each marks a target that does not exist yet (expectEmpty):\n`;
    text += intended.map((x) => `  · ${unitLine(x)}\n`).join('');
  }
  return {
    dead: dead.length,
    localWentLive: local.length,
    packWentLive: pack.length,
    text,
    deadLines: dead.map(unitLine),
    localWentLiveLines: local.map(unitLine),
    packWentLiveLines: pack.map(unitLine),
    stale: [
      ...(dead.length > 0 ? [`${dead.length} dead selector unit(s)`] : []),
      ...(local.length > 0 ? [`${local.length} expectEmpty unit(s) went live — remove the markers`] : []),
    ],
    staleIds: new Set([...dead, ...local].map((x) => x.id)),
  };
}
