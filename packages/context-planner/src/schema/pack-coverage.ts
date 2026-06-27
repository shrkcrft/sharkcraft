/**
 * Per-field coverage markers for an `IContextPack`.
 *
 * Distinguishes "computed and genuinely empty" from "not computed" so a
 * consumer reading e.g. `rules: []` can tell whether no rules apply versus the
 * prerequisite index was never built. Without this, an empty array reads as
 * "no risks" rather than "risk analysis was skipped".
 *
 * Part of `sharkcraft.context-pack/v1`.
 */
export interface IPackCoverage {
  /**
   * True when the rule-graph bridge was present, so `rules` / `paths` /
   * `templates` were actually computed. False means they were OMITTED (run
   * `shrk rule-graph index`) — not that none apply.
   */
  rulesComputed: boolean;
  /**
   * True when risk analysis ran over the selected file set (requires the code
   * graph). False only when the graph store was missing and an empty pack was
   * returned.
   */
  risksComputed: boolean;
  /**
   * True when do-not-touch detection ran over the selected file set. Same
   * precondition as `risksComputed`.
   */
  doNotTouchComputed: boolean;
}
