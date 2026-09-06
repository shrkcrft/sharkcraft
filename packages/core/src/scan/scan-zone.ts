/**
 * Which lexical zone of a file a text-matching rule may match in.
 *
 * Every raw-text engine in shrk — the policy plane and the extraction DSL's
 * content-reading extractors — runs a pattern against file BYTES. Nothing in a
 * byte scan distinguishes a hit in executable code from a hit inside a `//`
 * comment or a string literal, and both directions of that blindness are real
 * defects: a rule keyed on a code construct fires on a doc comment that merely
 * DESCRIBES it (a false failure), and a count-ceiling regex counts an English
 * word inside a comment (a false green, since a real regression then hides
 * under the padded count).
 *
 * One vocabulary covers both engines on purpose. Two spellings of "which zone
 * do you mean" would be exactly the two-authorities bug this codebase keeps
 * paying for: a rule author who learned `scan` on one plane must not discover a
 * differently-named `context` on the next.
 *
 * Zoning is lexical, C/JS-family (`'`/`"`/`` ` `` strings, `//` and `/* … *\/`
 * comments). It is deliberately not AST-accurate — it does not need to be; it
 * needs to stop a regex from reading prose as code, across `.ts`, `.kt`,
 * `.swift` and `.scss` with one code path.
 */
export type ScanZone =
  /** Raw file text — every byte, comments included. The back-compatible default. */
  | 'all'
  /** Only executable code: comments AND string literals are blanked first. */
  | 'code'
  /** Only inside string literals. */
  | 'strings'
  /** Only inside comments — forbidden content in the prose itself. */
  | 'comments'
  /**
   * Code plus the CONTENTS of backtick template literals, with comments and
   * plain quoted strings blanked.
   *
   * A construct can legitimately live inside an embedded DSL — an inline
   * `template:` in a component decorator, a SQL or GraphQL tagged template. Bare
   * `code` blanks those, which would make the zone unusable for exactly the
   * surface a single-language linter already cannot see. This keeps them.
   */
  | 'code-and-templates';

/** Every valid {@link ScanZone}, for schema-level membership checks. */
export const SCAN_ZONES: readonly ScanZone[] = [
  'all',
  'code',
  'strings',
  'comments',
  'code-and-templates',
];
