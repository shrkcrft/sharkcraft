/**
 * How {@link parseFrontmatter} reads an UNQUOTED scalar (round 15 follow-up,
 * F6). The grammar — keys, lists, maps, block scalars, `[a, b]`, quoted
 * strings — is the same in both modes; only the reading of a plain value
 * differs.
 */
export enum FrontmatterScalarMode {
  /**
   * YAML plain-scalar semantics (the default): `42` / `1.5` are numbers,
   * `true` / `false` booleans, `null` / `~` null, and ` # …` after a value is
   * a comment.
   */
  Typed = 'typed',
  /**
   * Every unquoted value is its text, verbatim: `0001`, `true`, `null`,
   * `Fix #12` stay exactly as written (no typing, no trailing-comment strip).
   * A value wholly enclosed in one pair of quotes is still unquoted; one that
   * merely starts and ends with a quote (`"a" and "b"`) is text. Likewise a
   * value is a flow list only when its opening `[` closes at its end —
   * `[RFC] Adopt [Bun]` is text, `[a, b]` a list. For formats
   * whose values are strings by contract — decision records, Cursor `.mdc`
   * rules — whose old line splitters read values verbatim.
   */
  Text = 'text',
}
