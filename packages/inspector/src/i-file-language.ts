import type { CommentSyntax } from './comment-syntax.ts';

/** One row of THE extension → language table (`FILE_LANGUAGES`, `file-languages.ts`). */
export interface IFileLanguage {
  /** The language id — the vocabulary `shrk stats` prints and `appliesTo.languages` names (`typescript`). */
  readonly id: string;
  /** File extensions, dot included (`.ts`); matched case-insensitively. */
  readonly extensions: readonly string[];
  /** How the language writes comments (`shrk stats` line classification). */
  readonly comment: CommentSyntax;
}
