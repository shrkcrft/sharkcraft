import type { UnitDeadCause } from './unit-dead-cause.ts';
import type { UnitDeadWeight } from './unit-dead-weight.ts';

/**
 * What a REPORTER observed about one selector unit — the input row of
 * `settleUnitLiveness`. The reporter keeps its existing liveness predicate; it
 * only splits it into the two facts the settle needs, and never decides the
 * state itself.
 */
export interface IUnitObservation {
  /**
   * The list the unit belongs to — the SAME string the loader passed to the
   * normaliser as `listPath` (so the ledger's marks match), qualified with
   * `qualifyListPath` when one settle spans several owners.
   */
  readonly list: string;
  /** The unit as written: the glob or specifier (a negation keeps its `!`), or the boost-map key. */
  readonly unit: string;
  /**
   * RAW existence of the unit's target: does ANYTHING match it, before
   * exemptions, negations or effectiveness — `anyPerGlob > 0` for a boundary
   * `from` glob, `IDeadGlobUnit.matched > 0` (or not dead) for a gate glob,
   * the file existing for `discovery.targetFile`, `resolvable` for a forbidden
   * pattern, `Resolved` for a boost key. Decides a MARKED unit:
   * IntendedEmpty (false) or WentLive (true). `undefined`: an unread file could
   * decide it (→ Unproven). REQUIRED so no reporter conflates it with `live` by
   * omission — pass the same value to both when they are one predicate.
   */
  readonly exists: boolean | undefined;
  /**
   * EFFECTIVE contribution — today's dead predicate negated (`governedPerGlob > 0`,
   * a gate glob not in `dead`, `perGlob.matched > 0`). Decides an UNMARKED unit
   * (Live / Dead) and whether a went-live unit is effective (a marked unit whose
   * target exists but contributes nothing keeps its dead weight). `undefined`:
   * an unread file could refute it (→ Unproven).
   */
  readonly live: boolean | undefined;
  /** How many files / imports the unit matched, when the reporter knows. */
  readonly matched?: number;
  /** Why it is live, in the plane's words (`2 import(s)`, `now matches 3 files`) — the went-live line quotes it. */
  readonly liveBecause?: string;
  /** Why it matched nothing, in the plane's words (`matched 0 files`) — the dead line and every acceptance label quote it. */
  readonly deadReason?: string;
  /** Set when the unit is dead by SHAPE: never markable, so a marker on it is ignored (and refused at load). */
  readonly cause?: UnitDeadCause;
  /**
   * How the unit is named in coverage labels and printed lines (`fx.hint: src/x/**`).
   * Default: `unit`, or `<list>: <unit>` when one settle spans several lists.
   */
  readonly label?: string;
  /** Overrides the settle's default weight for this unit (the boundary `from` list mixes both). */
  readonly weight?: UnitDeadWeight;
}
