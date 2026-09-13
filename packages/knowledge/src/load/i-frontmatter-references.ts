/** What a Markdown `references:` frontmatter value becomes on the entry ({@link frontmatterReferences}). */
export interface IFrontmatterReferences {
  /**
   * The value for `entry.references` — undefined when the key declared nothing.
   * Usually a reference list; a NON-list value is carried verbatim, so the
   * validator and the stale-check report it exactly as they report the same
   * value in TypeScript.
   */
  readonly references?: unknown;
  /** Refusals, each `references[i]…: <why>` — the loader rejects the entry over any. */
  readonly refusals: readonly string[];
}
