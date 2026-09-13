import type { IImportedEntry } from '../model/imported-entry.ts';

/** One `.mdc` rule read by `parseCursorRule`: the entry, and every reason (part of) its frontmatter was not read. */
export interface ICursorRuleParse {
  readonly entry: IImportedEntry;
  /**
   * Why frontmatter did not reach the entry — a parse error naming the line
   * (in the top-level structure, a line naming no key: the whole frontmatter
   * is ignored; under one key the importer reads: that key alone), a field of
   * the wrong shape (that field is ignored), an unterminated block. A key the
   * importer does not read is never parsed. `[]`: read as declared. The
   * importer surfaces each as a warning; none is silent.
   */
  readonly problems: readonly string[];
}
