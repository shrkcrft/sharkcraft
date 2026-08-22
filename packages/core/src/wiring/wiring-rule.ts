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
 *   - collects the DECLARED token set (via the extraction DSL on
 *     `declared`, see {@link ExtractorKind}), and
 *   - the REGISTERED token set (likewise from `registered`), then
 *   - flags every declared token that is NOT in the registered set.
 *
 * The engine is generic and deterministic (no AI, no language-specific
 * knowledge). Projects supply the rules as data via
 * `sharkcraft.config.ts` `wiringRules[]` (or a pack), so the engine never
 * hard-codes any project-specific identifier.
 */

/**
 * How an {@link IWiringSource} pulls ids out of a file WITHOUT a compiler.
 *
 * Each kind is a small, independently testable extractor. They exist because
 * the interesting id-spaces live in constructs a regex describes badly: an
 * array literal, an enum body, a string union, the nth argument of a call.
 *
 *   - `regex-capture`         — capture group 1 of `pattern` (the escape hatch).
 *   - `array-members`         — elements of the `anchor` array literal.
 *   - `object-keys`           — top-level keys (or string values, see `capture`)
 *                               of the `anchor` object literal.
 *   - `enum-members`          — members of `enum <anchor> { … }` (name or value).
 *   - `export-names`          — every exported binding name in the file.
 *   - `call-args`             — argument `argIndex` of every call to `anchor`.
 *   - `decorator-args`        — argument `argIndex` of every `@anchor(…)`.
 *   - `string-union-members`  — the string literals of `type <anchor> = 'a' | 'b'`.
 *   - `json-path`             — leaves selected by `jsonPath` in a JSON document.
 */
export type ExtractorKind =
  | 'regex-capture'
  | 'array-members'
  | 'object-keys'
  | 'enum-members'
  | 'export-names'
  | 'call-args'
  | 'decorator-args'
  | 'string-union-members'
  | 'json-path';

/**
 * Which half of a key/value construct becomes the id. Applies to
 * `object-keys` and `enum-members`; ignored by every other kind.
 *
 * `name` (default) captures the key/member identifier; `value` captures the
 * string/number literal it is assigned. A registry keyed by an enum's *values*
 * needs `value`; one keyed by its member names needs `name`.
 */
export type ExtractorCapture = 'name' | 'value';

/**
 * One side (declared or registered) of a wiring rule: where to look + what to
 * capture.
 *
 * `extract` selects the extractor; `pattern` and `arrayProperty` are the
 * original two-mode sugar kept for compatibility (`pattern` ≡
 * `extract: 'regex-capture'`, `arrayProperty` ≡ `extract: 'array-members'`
 * with that `anchor`). Spelling a kind out alongside its own sugar field is
 * fine; setting two DIFFERENT modes is a configuration error.
 */
export interface IWiringSource {
  /** Project-relative globs selecting the files to scan (`**`/`*`/`?` supported). */
  readonly files: readonly string[];
  /**
   * Extractor kind. Omit to use the sugar (`pattern` / `arrayProperty`) to
   * select it implicitly. Setting it alongside a sugar field for a DIFFERENT
   * kind is a configuration error.
   */
  readonly extract?: ExtractorKind;
  /**
   * The construct to locate: the array/object/enum/type-alias name, the called
   * function, or the decorator. Required by every anchored kind
   * (`array-members`, `object-keys`, `enum-members`, `call-args`,
   * `decorator-args`, `string-union-members`).
   */
  readonly anchor?: string;
  /** Which argument carries the id for `call-args` / `decorator-args` (default 0). */
  readonly argIndex?: number;
  /**
   * Path into a parsed JSON document for `json-path`, e.g.
   * `symbols[*].name` or `compilerOptions.paths`. Supports `.key`, `[n]` and
   * `[*]`; a leading `$.` is accepted and ignored.
   */
  readonly jsonPath?: string;
  /** Name-vs-value capture for `object-keys` / `enum-members` (default `name`). */
  readonly capture?: ExtractorCapture;
  /**
   * Post-filter: keep only extracted ids this regex matches (unanchored
   * `test`). The stale-selector failure mode is usually "extracted the right
   * construct, wrong subset" — this narrows without a hand-built pattern.
   */
  readonly match?: string;
  /** Extra flags for {@link match} (e.g. `i`). */
  readonly matchFlags?: string;
  /**
   * Deny-filter, applied after {@link match}: drop every extracted id this
   * regex matches. The allow/deny pair is how a KNOWN, deliberate exception is
   * declared as data — e.g. a handful of intentionally-retired exports — so the
   * rule stays green and a NEW omission still turns it red. Anchor it
   * (`^(a|b)$`) unless a prefix match is really what you mean.
   */
  readonly exclude?: string;
  /** Extra flags for {@link exclude}. */
  readonly excludeFlags?: string;
  /**
   * Regex source for `regex-capture`. Capture group 1 is the token. Matched
   * per-file with the `g` flag always applied; add others via `flags`.
   */
  readonly pattern?: string;
  /** Extra regex flags to combine with the always-on `g`. */
  readonly flags?: string;
  /**
   * Sugar for `extract: 'array-members'` with this `anchor`. Captures the
   * identifier and quoted-string elements of every `<arrayProperty> = [ … ]`
   * or `<arrayProperty>: [ … ]` literal in the file.
   */
  readonly arrayProperty?: string;
}

/**
 * Author-declared expectations a rule must satisfy to be considered healthy.
 *
 * A rule engine is only as trustworthy as the author's ability to see what a
 * rule actually matched, and the dominant real-world failure is a stale
 * selector that silently matches nothing. These hooks let a rule be TESTED like
 * code instead of trusted like config: `shrk gates coverage` evaluates them
 * across every plane and fails when an expectation breaks.
 */
export interface IRuleSelfTest {
  /** The rule's primary side must extract at least this many distinct ids. */
  readonly expectMatchesAtLeast?: number;
  /** Positive fixtures: every id here MUST be extracted. */
  readonly expectIds?: readonly string[];
  /** Negative fixtures: none of these ids may be extracted. */
  readonly expectNotIds?: readonly string[];
}

export interface IWiringRule {
  /** Stable id, surfaced in findings and usable with `--only`. */
  readonly id: string;
  /** Human-readable description of what the rule guarantees. */
  readonly description?: string;
  /** `error` (default) fails the check / gate; `warning` reports without failing. */
  readonly severity?: 'error' | 'warning';
  /**
   * Tokens that are declared/used and therefore MUST be wired up. Omitted only
   * when {@link chain} is used instead.
   */
  readonly declared?: IWiringSource;
  /**
   * The registered superset the declared tokens must belong to. An array of
   * sources combines per {@link registeredMode} (UNION by default: a token is
   * registered if any source has it).
   */
  readonly registered?: IWiringSource | readonly IWiringSource[];
  /**
   * Multi-hop form: an ordered list of ≥2 sources evaluated as
   * `hop0 ⊆ hop1`, `hop1 ⊆ hop2`, … so a "declared → registered → wired"
   * three-hop seam is ONE rule instead of three brittle ones. Mutually
   * exclusive with `declared`/`registered`.
   */
  readonly chain?: readonly IWiringSource[];
  /**
   * How multiple `registered` sources combine. `union` (default): a token is
   * registered if ANY sink has it. `intersection`: it must appear in EVERY
   * sink — the explicit answer to "registered in the wrong one of N sinks".
   */
  readonly registeredMode?: 'union' | 'intersection';
  /**
   * When set, declared and registered tokens are matched WITHIN the same group
   * (group key derived from each token's file path), not the global pool.
   * Unset = global. `dir` groups by directory; `package` by the first two path
   * segments.
   */
  readonly groupBy?: 'dir' | 'package';
  /**
   * The set relation to enforce.
   *   - `subset` (default): every declared token must be registered.
   *   - `parity`: also report every registered token missing from declared.
   *   - `disjoint`: no token may appear on BOTH sides (an exclusion invariant —
   *     e.g. "nothing in the deprecated list may still be registered").
   */
  readonly mode?: 'subset' | 'parity' | 'disjoint';
  /**
   * Violation headline. Supports `{id}` / `{token}` (the offending token),
   * `{file}`, `{line}`, and `{rule}`. Falls back to a generated line.
   */
  readonly message?: string;
  /**
   * Treat "this rule extracted nothing to check" as a FAILURE rather than a
   * loud skip. A rule that matches nothing is a bug in the rule, never a pass.
   *
   * DEFAULTS TO TRUE for `error`-severity rules (an error rule exists to block
   * a build; one matching zero subjects is broken). `warning`-severity rules
   * default to false, since a warning plane may legitimately cover an empty
   * set. Set explicitly to override either default.
   */
  readonly failOnEmpty?: boolean;
  /** Author-declared expectations checked by `shrk gates coverage`. */
  readonly selfTest?: IRuleSelfTest;
  /** Remediation hint shown on every violation of this rule. */
  readonly hint?: string;
  /** Parity hint for a declared token missing from registered (falls back to `hint`). */
  readonly hintDeclaredMissing?: string;
  /** Parity hint for a registered token missing from declared (falls back to `hint`). */
  readonly hintRegisteredMissing?: string;
}
