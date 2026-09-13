/**
 * What one selector unit is, once the one settle (`settleUnitLiveness`) has
 * compared the reporter's observation with the marker ledger:
 *
 *   marked? | observation            | state
 *   --------+------------------------+---------------
 *   no      | live === undefined     | Unproven
 *   no      | live                   | Live
 *   no      | !live                  | Dead
 *   yes     | exists === undefined   | Unproven
 *   yes     | !exists                | IntendedEmpty
 *   yes     | exists                 | WentLive
 *
 * A marker never changes the liveness JUDGEMENT, only how it settles.
 */
export enum UnitLivenessState {
  /** Contributes — not printed by text surfaces. */
  Live = 'live',
  /** Unmarked and matches nothing: `typo, retired target, or a target that does not exist yet`. */
  Dead = 'dead',
  /** Marked, and its target does not exist: an explicit, printed acceptance (`acceptedBy: expectEmpty`). */
  IntendedEmpty = 'intended-empty',
  /** Marked, and its target now exists: the fence went live — the marker is stale drift. */
  WentLive = 'went-live',
  /** A file that could decide it was not read: no claim either way (the read gap vetoes). */
  Unproven = 'unproven',
}
