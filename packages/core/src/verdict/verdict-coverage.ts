/**
 * How much of the requested scope a verdict actually examined.
 *
 * Every clean verdict is a claim about a scope: "no violations AMONG WHAT I
 * LOOKED AT". A verdict that looked at less than it was asked about — a capped
 * scan, a corpus resolved from the wrong root, a subset rule whose declared
 * selector never reached a registered member — used to render in the vocabulary
 * of the REQUESTED set while having examined a smaller one. The disconfirming
 * number was usually printed on the same screen; nothing compared it to the
 * request.
 *
 * This is that comparison, as a required part of every verdict. Engines fill it
 * in from counts they already compute; they never decide "pass" from it
 * themselves. {@link coverageShortfall} is the ONE rule that turns it into a
 * veto, and the CLI's envelope builder is the one place that applies the veto
 * to an exit code.
 */
export interface IVerdictCoverage {
  /** What one unit is, in the verdict's own words (`rules`, `registered tokens`, `files`). */
  readonly unit: string;
  /**
   * Units the REQUEST covers, after any narrowing the caller deliberately asked
   * for (`--changed-only`, `--only`, an explicit exemption list). Narrowing is
   * not a shortfall; an accident is.
   */
  readonly expected: number;
  /** Units actually examined. */
  readonly examined: number;
  /**
   * True when a cap (a file budget, a wall-clock limit) stopped the scan before
   * it reached every unit. A capped scan is never clean and never acceptable —
   * the unexamined remainder was never looked at, whatever it holds.
   */
  readonly capped?: boolean;
  /** Labels of (at most 20) units that were not examined, for the verdict line. */
  readonly unexamined?: readonly string[];
  /** How many units were not examined, when {@link unexamined} is truncated. */
  readonly unexaminedTotal?: number;
  /** The root the scope was resolved against — names where discovery looked. */
  readonly root?: string;
  /** Why the gap exists, in a few words (`skipped or could not run`). */
  readonly reason?: string;
  /**
   * Who accepted a gap. Set ONLY from an explicit user input — a flag
   * (`--allow-empty`) or a rule field (`registeredExtras`) — and printed
   * verbatim, so an accepted gap stays visible. Never a default.
   */
  readonly acceptedBy?: string;
  /**
   * With {@link acceptedBy}: the minimum examined/expected ratio the acceptance
   * covers. Undefined accepts any partial scope; an EMPTY scope (expected 0) is
   * never accepted by a ratio, only by an unconditional acceptance.
   */
  readonly acceptedRatio?: number;
  /**
   * Whose coverage this is (a rule id), prefixed to its shortfall so a verdict
   * over many rules says which one fell short. Optional — the envelope builder
   * supplies the rule id when a producer leaves it out.
   */
  readonly subject?: string;
}
