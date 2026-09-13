import type { FrontmatterScalarMode } from './frontmatter-scalar-mode.ts';

/** Options of {@link parseFrontmatter}. */
export interface IParseFrontmatterOptions {
  /**
   * Added to every line number an error names. A caller parsing the block
   * between a document's `---` delimiters passes the number of lines before it,
   * so `line N` is the FILE's line N (default `0`: block-relative).
   */
  readonly lineOffset?: number;
  /**
   * How an unquoted scalar is read (round 15 follow-up, F6): `Typed` (the
   * default — YAML numbers / booleans / null, ` # comment` stripped) or `Text`
   * (verbatim). The grammar is the same in both modes.
   */
  readonly scalars?: FrontmatterScalarMode;
  /**
   * The top-level keys the caller reads (round 15 follow-up review). When set,
   * every OTHER top-level key's block — its key line and the indented,
   * list-item, blank and comment lines under it — is skipped UNPARSED and is
   * absent from the result: a reader is never failed by YAML the parser does
   * not speak under a key it never reads (a plain scalar wrapped onto an
   * indented line, `decision makers:`, a map nested two levels deep) — the way
   * the Markdown knowledge loader blanks a key it drops. A top-level line that
   * names no key (`just text`) is still an error, so `[]` (no key read) checks
   * that top-level structure alone. Omitted: every key is read.
   */
  readonly keys?: readonly string[];
  /**
   * The top-level keys the caller reads as a LIST (round 15 closing, A1). When
   * set, an inline `[…]` value under any OTHER top-level key is not a flow list
   * but that key's one value, read like any unquoted scalar — `title: [WIP]` is
   * the text `[WIP]`, as the line splitters of formats whose fields are strings
   * read it. A block list (`key:` + `- item` lines) is structure, and stays a
   * list under any key. Nested values are unaffected. Omitted: every inline
   * `[…]` is a flow list (YAML).
   */
  readonly listKeys?: readonly string[];
}
