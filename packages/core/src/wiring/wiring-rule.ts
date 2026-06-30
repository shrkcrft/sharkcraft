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

/**
 * One side (declared or registered) of a wiring rule: where to look + what to
 * capture.
 *
 * EXACTLY ONE of `pattern` / `arrayProperty` must be set:
 *   - `pattern`: capture-group-1 of a regex over each file (the classic mode).
 *   - `arrayProperty`: capture each element token of the array literal assigned
 *     to a property/const of that name — covers both
 *     `export const ARR = [A, B, C]` and an inline `arrayProperty: [A, B, C]`.
 */
export interface IWiringSource {
  /** Project-relative globs selecting the files to scan (`**`/`*`/`?` supported). */
  readonly files: readonly string[];
  /**
   * Regex source. Capture group 1 is the token. Matched per-file with the `g`
   * flag always applied; add others (e.g. `i`, `m`) via `flags`. Mutually
   * exclusive with `arrayProperty`.
   */
  readonly pattern?: string;
  /** Extra regex flags to combine with the always-on `g`. */
  readonly flags?: string;
  /**
   * Name of an array-valued property/const whose elements are the tokens.
   * Captures identifier and quoted-string elements of every
   * `<arrayProperty> = [ … ]` or `<arrayProperty>: [ … ]` literal in the file.
   * Mutually exclusive with `pattern`.
   */
  readonly arrayProperty?: string;
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
  /**
   * The registered superset the declared tokens must belong to. An array of
   * sources is treated as a UNION: a token is registered if any source has it.
   */
  readonly registered: IWiringSource | readonly IWiringSource[];
  /**
   * When set, declared and registered tokens are matched WITHIN the same group
   * (group key derived from each token's file path), not the global pool.
   * Unset = global. `dir` groups by directory; `package` by the first two path
   * segments.
   */
  readonly groupBy?: 'dir' | 'package';
  /**
   * `subset` (default): every declared token must be registered. `parity`: also
   * report every registered token missing from the declared set
   * (direction-aware).
   */
  readonly mode?: 'subset' | 'parity';
  /** Remediation hint shown on every violation of this rule. */
  readonly hint?: string;
  /** Parity hint for a declared token missing from registered (falls back to `hint`). */
  readonly hintDeclaredMissing?: string;
  /** Parity hint for a registered token missing from declared (falls back to `hint`). */
  readonly hintRegisteredMissing?: string;
}
