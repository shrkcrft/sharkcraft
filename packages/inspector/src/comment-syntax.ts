/**
 * How a language writes a single-line / block comment — the line classifier
 * `shrk stats` counts code / comment / blank lines with. One value per
 * {@link IFileLanguage} (`file-languages.ts`).
 */
export enum CommentSyntax {
  CFamily = 'c-family',
  Hash = 'hash',
  Html = 'html',
  Sql = 'sql',
  Lua = 'lua',
  Lisp = 'lisp',
  None = 'none',
}
