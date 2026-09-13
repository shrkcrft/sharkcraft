import type { IGlobListUnits } from './i-glob-list-units.ts';

/**
 * One gate-plane glob list as the liveness settle observes it (round 13).
 *
 * `list` is the marker ledger's `list` for these globs — `files`, `to.files`,
 * `watchFiles`, `generatedGlob`, or a side-qualified `declared.files` when a
 * rule reads several sources (`qualifyListPath`); the marks handed to the
 * settle must be qualified the same way. `units` is the list judged by the one
 * dead-unit decision (`globListUnits`).
 */
export interface IGlobLivenessList {
  readonly list: string;
  /**
   * Display prefix for each unit of this list. Set when the rule reads more
   * than one list: a unit then prints `<label>: <glob>` — today's dead-glob
   * selector (`declared: src/moved/*.ts`). Absent: the bare glob.
   */
  readonly label?: string;
  /** The globs as the loader normalised them (a negation keeps its `!`). */
  readonly globs: readonly string[];
  readonly units: IGlobListUnits;
}
