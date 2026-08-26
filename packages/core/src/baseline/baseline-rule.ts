import type { IRuleSelfTest, IWiringSource } from '../wiring/wiring-rule.ts';

/**
 * Baseline / ledger drift rules — the "committed artifact silently drifted" plane.
 *
 * Projects accumulate hand-rolled trios: a committed baseline file, a script
 * that recomputes it, and a bespoke test that fails on drift — one per adoption
 * ledger, API digest, coverage ratchet, allow-list, or byte-pin. The pattern is
 * identical every time; only the COMPUTE and the BASELINE FILE differ. Each
 * re-implementation re-invents the update flow, and each tends to be
 * one-directional (catches additions, misses deletions).
 *
 * One engine gives every ledger the same two-way semantics, the same explicit
 * `update` bless step, the same human-readable diff, the same CI wiring, and
 * the same loud-on-empty safety. No AI: the value is a deterministic guarantee
 * that all N entries were compared, every commit, with no agent in the loop.
 */

/** How the CURRENT value is (re)derived for comparison against the committed baseline. */
export interface IBaselineCompute {
  /**
   * `command` shells out and reads stdout; `extractor` harvests ids with the
   * wiring extraction DSL and never spawns anything.
   *
   * A `command` baseline is only ever run from the repo's OWN
   * `sharkcraft.config.ts` — the pack-merge seam drops a pack-contributed one,
   * mirroring the "pack-contributed verification commands are NOT auto-run"
   * contract.
   */
  readonly kind: 'command' | 'extractor';
  /** `kind: 'command'` — the shell command; its stdout is the current value. */
  readonly run?: string;
  /** `kind: 'extractor'` — a pure, filesystem-only id harvest. */
  readonly source?: IWiringSource;
  /**
   * Canonical form applied to BOTH sides before diffing, so reordering or
   * key-shuffling is not reported as a change.
   *
   *   - `auto` (default): `json-sorted-keys` when both sides parse as JSON,
   *     `lines` otherwise. A pure function of the two inputs.
   *   - `json-sorted-keys`: parse, sort object keys recursively, re-serialize.
   *   - `lines-sorted`: trim, drop blanks, sort.
   *   - `lines`: trim, drop trailing blanks; order-sensitive.
   *   - `raw`: byte comparison (only the trailing newline is normalized).
   */
  readonly canonical?: 'auto' | 'json-sorted-keys' | 'lines-sorted' | 'lines' | 'raw';
  /** Wall-clock cap for a `command` compute (default 60_000 ms). */
  readonly timeoutMs?: number;
}

export interface IBaselineRule {
  /** Stable id, used with `--id` and reported in every finding. */
  readonly id: string;
  /** What this baseline pins / why it matters. */
  readonly description?: string;
  /** Project-relative path of the COMMITTED artifact. */
  readonly baseline: string;
  /** How to (re)derive the current value. */
  readonly compute: IBaselineCompute;
  /**
   * Which direction of drift fails.
   *
   *   - `two-way` (default): gained OR lost entries fail. The safe default —
   *     one-directional ledgers are exactly how a silent deletion ships.
   *   - `additions-only`: only gained entries fail.
   *   - `no-shrink`: only lost entries fail (a ratchet).
   */
  readonly direction?: 'two-way' | 'additions-only' | 'no-shrink';
  /**
   * Compare as a keyed SET instead of a text blob: a JSON path selecting each
   * entry's key (e.g. `symbols[*].name`). The diff is then reported per key,
   * so a reordered or reformatted file is not a change and a real
   * addition/removal is named exactly.
   */
  readonly keyBy?: string;
  /**
   * Project-relative globs that feed this baseline. `--changed-only` recomputes
   * a rule only when one of them changed; a `command` rule without them cannot
   * be scoped and is reported as skipped under `--changed-only` rather than
   * silently passing.
   */
  readonly watchFiles?: readonly string[];
  /**
   * Treat "this rule computed nothing" as a FAILURE rather than a
   * loud skip. A rule that matches nothing is a bug in the rule, never a pass.
   *
   * DEFAULTS TO TRUE for `error`-severity rules (an error rule exists to block
   * a build; one matching zero subjects is broken). `warning`-severity rules
   * default to false, since a warning plane may legitimately cover an empty
   * set. Set explicitly to override either default.
   */
  readonly failOnEmpty?: boolean;
  /**
   * Declare that an EMPTY result is the expected, passing state.
   *
   * The loud-skip contract exists because an empty compute almost always means
   * a stale selector, and calling that a pass is the silent green this plane
   * prevents. A FENCE inverts that: "no edge from A to B" is asserted precisely
   * by the set being empty, so the rule could otherwise never be green and
   * would be useless in CI.
   *
   * Opt-in, and narrow: it turns the empty case into a verified pass and
   * nothing else. A non-empty result is still drift per {@link direction}, so
   * the assertion keeps its teeth. Mutually exclusive with `failOnEmpty: true`,
   * which asserts the opposite.
   */
  readonly expectEmpty?: boolean;
  /** Author-declared expectations checked by `shrk gates coverage`. */
  readonly selfTest?: IRuleSelfTest;
  /** `error` (default) fails the check; `warning` reports without failing. */
  readonly severity?: 'error' | 'warning';
  /** Remediation hint shown on drift (defaults to the `shrk baseline update` line). */
  readonly hint?: string;
}
