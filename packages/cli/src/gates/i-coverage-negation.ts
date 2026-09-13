/**
 * A LIVE negation inside a gate rule and what it excludes, as `gates coverage`
 * reports it (the `negations` of `sharkcraft.gate-coverage/v1`). The narrowing
 * a `!` performs is printed (`excludes: !src/**\/*.spec.ts (512 files)`), so a
 * reader sees what the rule does NOT measure.
 */
export interface ICoverageNegation {
  /** The side-qualified negation (`declared: !src/**\/*.spec.ts`). */
  readonly selector: string;
  /** Files it excludes from its own list's positive set (at least 1). */
  readonly excludes: number;
}
