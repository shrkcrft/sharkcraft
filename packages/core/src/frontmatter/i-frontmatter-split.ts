/** A Markdown document split at its frontmatter delimiters by {@link splitFrontmatter}. */
export interface IFrontmatterSplit {
  /** The lines between the `---` delimiters, `\n`-joined; `undefined` when the document has none. */
  readonly frontmatter: string | undefined;
  /** Everything after the closing delimiter line — the whole (normalised) document when there is no frontmatter. */
  readonly body: string;
  /** Lines before the frontmatter's first line — pass as `lineOffset` so a parse error names the FILE's line. */
  readonly lineOffset: number;
  /**
   * An opening `---` line with no closing one. Read as "no frontmatter" (a
   * Markdown document may open with a thematic break), but a caller with a
   * warning channel says so.
   */
  readonly unterminated: boolean;
}
