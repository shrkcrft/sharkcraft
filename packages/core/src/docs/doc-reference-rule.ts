/**
 * Doc-reference rules — the "free-text id has gone stale" plane.
 *
 * shrk already validates id references, but only the STRUCTURED `references[]`
 * on a knowledge entry. The same ids written as prose — a README, an
 * architecture doc, an agent skill file saying `shrk gen nge.foo` — are
 * unchecked, and markdown has no build or type-check behind it. So a table of
 * "which template for which task" drifts from the registry with zero signal
 * until someone runs the command and it fails.
 *
 * This plane points the existing reference resolver at that surface. It is the
 * `import-edges` move: expose an asset the engine already owns (the registries
 * + the nearest-id suggester) over a surface it did not cover.
 */

/**
 * When a matched token counts as a REFERENCE rather than an incidental mention.
 *
 * The one risk of linting prose is false positives on text that merely contains
 * an id-shaped string. Context is the cheap discriminator: a real instruction is
 * nearly always written as code.
 *
 *   - `backtick` (default) — only tokens inside a `` `code span` `` or a fenced
 *     block. A genuine `` `shrk gen nge.foo` `` qualifies; a sentence musing
 *     about `nge.something` in plain prose does not.
 *   - `off` — every match is a reference. Correct for a file that is ONLY a
 *     reference table.
 *   - `after` — only tokens preceded on the same line by one of `afterWords`
 *     (e.g. `shrk gen`, `template`). The narrowest option.
 */
export type DocReferenceContext = 'backtick' | 'off' | 'after';

/** One prose-reference rule. */
export interface IDocReferenceRule {
  /** Stable id, surfaced in findings and usable with `--id` / `--only`. */
  readonly id: string;
  /** What this rule guards. */
  readonly description?: string;
  /** Project-relative globs selecting the documents to scan. */
  readonly files: readonly string[];
  /**
   * Regex describing the id SHAPE worth considering, e.g.
   * `\bnge[.-][a-z0-9-]+\b`. Deliberately project-supplied: the engine has no
   * business guessing what an id looks like in someone else's namespace.
   */
  readonly tokenPattern: string;
  /** Extra flags for {@link tokenPattern} (`g` is always applied). */
  readonly tokenPatternFlags?: string;
  /**
   * Registries a token may resolve against. A token resolving in ANY of them is
   * fine — a `nge.foo` may legitimately be a template or a playbook.
   */
  readonly resolvesAs: readonly string[];
  /** When a match counts as a reference (default `backtick`). */
  readonly requireContext?: DocReferenceContext;
  /** Cue words for `requireContext: 'after'`. */
  readonly afterWords?: readonly string[];
  /**
   * Tokens that are deliberately NOT references — a hypothetical in an example.
   * Listed here they are reviewed in the diff that adds them, exactly like a
   * `handMaintained` bless.
   */
  readonly exempt?: readonly string[];
  /**
   * An HTML-comment marker that exempts the line carrying it, e.g.
   * `ref-allow` matches a line ending `<!-- ref-allow -->`. The in-file form of
   * `exempt`, for a doc whose examples would otherwise need a config entry each.
   */
  readonly exemptMarker?: string;
  /**
   * Treat "this rule matched no tokens" as a FAILURE rather than a loud skip.
   * A rule scanning zero tokens is enforcing nothing; a moved doc directory
   * must not read as a pass.
   *
   * Defaults to TRUE for `error`-severity rules, matching every other plane.
   */
  readonly failOnEmpty?: boolean;
  /** Author-declared expectations checked by `shrk gates coverage`. */
  readonly selfTest?: {
    readonly expectMatchesAtLeast?: number;
    readonly expectIds?: readonly string[];
    readonly expectNotIds?: readonly string[];
  };
  /** `error` (default) fails the check; `warning` reports without failing. */
  readonly severity?: 'error' | 'warning';
  /** Remediation hint shown on every unresolved reference. */
  readonly hint?: string;
}
