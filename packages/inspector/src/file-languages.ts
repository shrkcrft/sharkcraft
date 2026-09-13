/**
 * THE per-file extension → language authority (round 15, 15.1).
 *
 * Promoted from `shrk stats` (`repository-stats.ts`, where it was
 * module-private), because a convention's `appliesTo.languages` filter needs a
 * per-file language and the tree had four unrelated maps with four different
 * vocabularies. This is the widest one and the vocabulary `shrk stats` prints
 * (`typescript`, `javascript`, `python`, …), so an author can read the ids
 * they may write off `shrk stats`. `shrk stats`, `conventionApplicability` and
 * the self-config doctor's language-id check read this table and nothing else.
 *
 * (The polyglot `LanguageId` enum, `languages/`, is a different, workspace-level
 * question — which toolchains a repo runs — and keeps its own seven ids.)
 */
import * as nodePath from 'node:path';
import { CommentSyntax } from './comment-syntax.ts';
import type { IFileLanguage } from './i-file-language.ts';

export const FILE_LANGUAGES: readonly IFileLanguage[] = Object.freeze([
  { id: 'typescript', extensions: ['.ts', '.tsx', '.mts', '.cts'], comment: CommentSyntax.CFamily },
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], comment: CommentSyntax.CFamily },
  { id: 'java', extensions: ['.java'], comment: CommentSyntax.CFamily },
  { id: 'kotlin', extensions: ['.kt', '.kts'], comment: CommentSyntax.CFamily },
  { id: 'scala', extensions: ['.scala'], comment: CommentSyntax.CFamily },
  { id: 'groovy', extensions: ['.groovy'], comment: CommentSyntax.CFamily },
  { id: 'csharp', extensions: ['.cs'], comment: CommentSyntax.CFamily },
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], comment: CommentSyntax.CFamily },
  { id: 'c', extensions: ['.c', '.h'], comment: CommentSyntax.CFamily },
  { id: 'go', extensions: ['.go'], comment: CommentSyntax.CFamily },
  { id: 'rust', extensions: ['.rs'], comment: CommentSyntax.CFamily },
  { id: 'swift', extensions: ['.swift'], comment: CommentSyntax.CFamily },
  { id: 'php', extensions: ['.php'], comment: CommentSyntax.CFamily },
  { id: 'dart', extensions: ['.dart'], comment: CommentSyntax.CFamily },
  { id: 'python', extensions: ['.py', '.pyi'], comment: CommentSyntax.Hash },
  { id: 'ruby', extensions: ['.rb'], comment: CommentSyntax.Hash },
  { id: 'shell', extensions: ['.sh', '.bash', '.zsh', '.fish'], comment: CommentSyntax.Hash },
  { id: 'perl', extensions: ['.pl', '.pm'], comment: CommentSyntax.Hash },
  { id: 'r', extensions: ['.r', '.R'], comment: CommentSyntax.Hash },
  { id: 'yaml', extensions: ['.yaml', '.yml'], comment: CommentSyntax.Hash },
  { id: 'toml', extensions: ['.toml'], comment: CommentSyntax.Hash },
  { id: 'ini', extensions: ['.ini', '.cfg', '.conf'], comment: CommentSyntax.Hash },
  { id: 'dockerfile', extensions: ['.dockerfile'], comment: CommentSyntax.Hash },
  { id: 'makefile', extensions: ['.mk'], comment: CommentSyntax.Hash },
  { id: 'html', extensions: ['.html', '.htm'], comment: CommentSyntax.Html },
  { id: 'xml', extensions: ['.xml', '.xsd', '.xsl'], comment: CommentSyntax.Html },
  { id: 'vue', extensions: ['.vue'], comment: CommentSyntax.Html },
  { id: 'svelte', extensions: ['.svelte'], comment: CommentSyntax.Html },
  { id: 'sql', extensions: ['.sql'], comment: CommentSyntax.Sql },
  { id: 'css', extensions: ['.css', '.scss', '.sass', '.less'], comment: CommentSyntax.CFamily },
  { id: 'lua', extensions: ['.lua'], comment: CommentSyntax.Lua },
  { id: 'elixir', extensions: ['.ex', '.exs'], comment: CommentSyntax.Hash },
  { id: 'clojure', extensions: ['.clj', '.cljs'], comment: CommentSyntax.Lisp },
  { id: 'lisp', extensions: ['.lisp', '.lsp', '.el'], comment: CommentSyntax.Lisp },
  { id: 'json', extensions: ['.json', '.jsonc'], comment: CommentSyntax.None },
  { id: 'markdown', extensions: ['.md', '.mdx'], comment: CommentSyntax.None },
  { id: 'text', extensions: ['.txt'], comment: CommentSyntax.None },
] satisfies IFileLanguage[]);

const EXTENSION_INDEX: ReadonlyMap<string, IFileLanguage> = (() => {
  const m = new Map<string, IFileLanguage>();
  for (const def of FILE_LANGUAGES) {
    for (const ext of def.extensions) m.set(ext.toLowerCase(), def);
  }
  return m;
})();

/** Extension-less files named for their language (case-insensitive basename). */
const BASENAME_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['gnumakefile', 'makefile'],
]);

/** The language of `path` (absolute or project-relative): a basename override, else its extension; `null` when unknown. */
export function fileLanguageOf(path: string): IFileLanguage | null {
  const override = BASENAME_OVERRIDES.get(nodePath.basename(path).toLowerCase());
  if (override) {
    const def = FILE_LANGUAGES.find((d) => d.id === override);
    if (def) return def;
  }
  const ext = nodePath.extname(path).toLowerCase();
  if (!ext) return null;
  return EXTENSION_INDEX.get(ext) ?? null;
}

/** The language whose table row lists `extension` (`.ts` or `ts`), or `null`. */
export function fileLanguageForExtension(extension: string): IFileLanguage | null {
  const ext = (extension.startsWith('.') ? extension : `.${extension}`).toLowerCase();
  return EXTENSION_INDEX.get(ext) ?? null;
}

/** Every language id of the table, in table order — THE vocabulary `appliesTo.languages` may name. */
export function fileLanguageIds(): readonly string[] {
  return FILE_LANGUAGES.map((d) => d.id);
}
