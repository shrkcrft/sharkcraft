/**
 * Wiring rules — the "completeness plane".
 *
 * Boundary/architecture rules cover the DIRECTION plane: which imports a file
 * may NOT make. Wiring rules cover the complementary COMPLETENESS plane: a
 * value/identifier that is DECLARED in one place must also be REGISTERED
 * (wired up) somewhere else, or the build is green but the feature silently
 * does nothing at runtime ("declared but not wired").
 *
 * A rule is a pure, data-defined set-membership check across files — the same
 * extraction the boundary engine runs, but over captured string tokens instead
 * of import paths. Each rule:
 *   - collects the DECLARED token set (capture group 1 of `declared.pattern`
 *     over the files matching `declared.files`), and
 *   - the REGISTERED token set (likewise from `registered`), then
 *   - flags every declared token that is NOT in the registered set.
 *
 * The engine is generic and deterministic (no AI, no language-specific
 * knowledge). Projects supply the rules as data via
 * `sharkcraft.config.ts` `wiringRules[]` (or a pack), so the engine never
 * hard-codes any project-specific identifier.
 */

/** One side (declared or registered) of a wiring rule: where to look + what to capture. */
export interface IWiringSource {
  /** Project-relative globs selecting the files to scan (`**`/`*`/`?` supported). */
  readonly files: readonly string[];
  /**
   * Regex source. Capture group 1 is the token. Matched per-file with the `g`
   * flag always applied; add others (e.g. `i`, `m`) via `flags`.
   */
  readonly pattern: string;
  /** Extra regex flags to combine with the always-on `g`. */
  readonly flags?: string;
}

export interface IWiringRule {
  /** Stable id, surfaced in findings and usable with `--only`. */
  readonly id: string;
  /** Human-readable description of what the rule guarantees. */
  readonly description?: string;
  /** `error` (default) fails the check / gate; `warning` reports without failing. */
  readonly severity?: 'error' | 'warning';
  /** Tokens that are declared/used and therefore MUST be wired up. */
  readonly declared: IWiringSource;
  /** The registered superset the declared tokens must belong to. */
  readonly registered: IWiringSource;
  /** Remediation hint shown on every violation of this rule. */
  readonly hint?: string;
}
