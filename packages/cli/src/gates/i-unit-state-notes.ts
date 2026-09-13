/**
 * What THE shared unit-state renderer (`unitStateNotes`) found across a plane
 * verb's rules — the printed block, the per-unit lines and the counts the
 * verb's clean line reads.
 */
export interface IUnitStateNotes {
  /** Unmarked dead units of rules NOT already reported as matching nothing (advisory). */
  readonly dead: number;
  /** LOCAL `expectEmpty` markers whose target appeared — ✓ withheld, fails under `--fail-on-dead-units`. */
  readonly localWentLive: number;
  /** PACK markers whose target appeared — INFO, never a failure, never the consumer's to remove. */
  readonly packWentLive: number;
  /** The block to print (empty when there is nothing to say), each line `\n`-terminated. */
  readonly text: string;
  /**
   * The same units as bare lines (`<rule id>: <formatUnitLiveness(u)>`, causes
   * left to the caller's footer) — what a surface that prints NOTES instead of
   * a block (finish, quality) decorates with its own `[advisory]` / `[info]`.
   */
  readonly deadLines: readonly string[];
  readonly localWentLiveLines: readonly string[];
  readonly packWentLiveLines: readonly string[];
  /**
   * The clauses a clean line must carry instead of its ✓ (`2 dead selector
   * unit(s)`, `1 expectEmpty unit(s) went live — remove the markers`). Pack
   * went-live units never withhold the ✓ (INFO).
   */
  readonly stale: readonly string[];
  /** Rule ids with a dead or LOCAL went-live unit — their per-rule row reads `⚠`, never `✓`. */
  readonly staleIds: ReadonlySet<string>;
}
