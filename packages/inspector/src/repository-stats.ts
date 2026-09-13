/**
 * Repository statistics — per-language file counts, bytes, line totals,
 * code/comment/blank line breakdowns, averages, and the top-N largest
 * files in the workspace.
 *
 * Deterministic and read-only: given the same project, two consecutive
 * calls produce the same output (modulo `generatedAt`).
 *
 * Comment detection is line-prefix based (`//`, `#`, `--`, `<!--`) and
 * tracks the most common single-line and block forms per language. It is
 * intentionally not a real parser — that would couple this module to
 * every language toolchain we support.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { CommentSyntax } from './comment-syntax.ts';
import { fileLanguageOf } from './file-languages.ts';
import type { IFileLanguage } from './i-file-language.ts';

export const REPOSITORY_STATS_SCHEMA = 'sharkcraft.repository-stats/v1';

export interface IRepositoryStatsLanguage {
  language: string;
  extensions: readonly string[];
  files: number;
  bytes: number;
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
  averageFileBytes: number;
  averageFileLines: number;
  largestFile: { path: string; bytes: number; lines: number } | null;
}

export interface IRepositoryStatsTopFile {
  path: string;
  language: string;
  bytes: number;
  lines: number;
}

export interface IRepositoryStatsTotals {
  files: number;
  bytes: number;
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
}

export interface IRepositoryStats {
  schema: typeof REPOSITORY_STATS_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  totals: IRepositoryStatsTotals;
  byLanguage: readonly IRepositoryStatsLanguage[];
  topFiles: readonly IRepositoryStatsTopFile[];
  ignoredDirectories: readonly string[];
  truncated: boolean;
}

export interface IBuildRepositoryStatsOptions {
  cwd: string;
  /** Top-N largest files to surface (default 10). */
  maxTopFiles?: number;
  /** Hard cap on files walked (default 50_000). */
  maxFiles?: number;
  /** Filter to a single language (e.g. 'typescript'). */
  language?: string;
}

const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.nx',
  '.sharkcraft',
  '.claude',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  'coverage',
  '.gradle',
  '.mvn',
]);

// The extension → language table this module classified with is THE per-file
// language authority now (`file-languages.ts`, round 15): `appliesTo.languages`
// and the self-config doctor read the same rows `shrk stats` prints.

interface IWalkResult {
  files: readonly string[];
  truncated: boolean;
}

function walkRepository(root: string, maxFiles: number): IWalkResult {
  const out: string[] = [];
  const stack: string[] = [root];
  let truncated = false;
  while (stack.length > 0) {
    if (out.length >= maxFiles) {
      truncated = true;
      break;
    }
    const cur = stack.pop()!;
    let entries: string[];
    try {
      // Sort the walk so `topFiles` (byte-tie order) and `byLanguage` (tie
      // order) in `shrk stats` are deterministic, not filesystem-dependent.
      entries = readdirSync(cur).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED_DIR_NAMES.has(entry)) continue;
      const abs = nodePath.join(cur, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (st.isFile()) {
        out.push(abs);
        if (out.length >= maxFiles) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { files: out, truncated };
}

interface ILineCounts {
  total: number;
  code: number;
  comment: number;
  blank: number;
}

function countLines(text: string, syntax: CommentSyntax): ILineCounts {
  if (text.length === 0) return { total: 0, code: 0, comment: 0, blank: 0 };
  const lines = text.split(/\r?\n/);
  // Trailing empty entry from final newline shouldn't count.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlock = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      blank++;
      continue;
    }
    if (inBlock) {
      comment++;
      if (syntax === CommentSyntax.CFamily && trimmed.includes('*/')) inBlock = false;
      else if (syntax === CommentSyntax.Html && trimmed.includes('-->')) inBlock = false;
      else if (syntax === CommentSyntax.Sql && trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (isCommentLine(trimmed, syntax)) {
      comment++;
      if (opensBlockComment(trimmed, syntax)) inBlock = true;
      continue;
    }
    code++;
  }
  return { total: lines.length, code, comment, blank };
}

function isCommentLine(trimmed: string, syntax: CommentSyntax): boolean {
  switch (syntax) {
    case CommentSyntax.CFamily:
      return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
    case CommentSyntax.Hash:
      return trimmed.startsWith('#');
    case CommentSyntax.Html:
      return trimmed.startsWith('<!--');
    case CommentSyntax.Sql:
      return trimmed.startsWith('--') || trimmed.startsWith('/*');
    case CommentSyntax.Lua:
      return trimmed.startsWith('--');
    case CommentSyntax.Lisp:
      return trimmed.startsWith(';');
    case CommentSyntax.None:
    default:
      return false;
  }
}

function opensBlockComment(trimmed: string, syntax: CommentSyntax): boolean {
  if (syntax === CommentSyntax.CFamily || syntax === CommentSyntax.Sql) {
    return trimmed.includes('/*') && !trimmed.includes('*/');
  }
  if (syntax === CommentSyntax.Html) {
    return trimmed.startsWith('<!--') && !trimmed.includes('-->');
  }
  return false;
}

interface ILanguageAccumulator {
  def: IFileLanguage;
  files: number;
  bytes: number;
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
  largest: { path: string; bytes: number; lines: number } | null;
}

export async function buildRepositoryStats(
  opts: IBuildRepositoryStatsOptions,
): Promise<IRepositoryStats> {
  const projectRoot = nodePath.resolve(opts.cwd);
  const maxFiles = opts.maxFiles ?? 50_000;
  const maxTop = opts.maxTopFiles ?? 10;
  const filter = opts.language?.toLowerCase();

  const walk = walkRepository(projectRoot, maxFiles);
  const accs = new Map<string, ILanguageAccumulator>();
  const allFiles: IRepositoryStatsTopFile[] = [];

  for (const abs of walk.files) {
    const def = fileLanguageOf(abs);
    if (!def) continue;
    if (filter && def.id !== filter) continue;

    let bytes = 0;
    let counts: ILineCounts = { total: 0, code: 0, comment: 0, blank: 0 };
    try {
      const st = statSync(abs);
      bytes = st.size;
      if (bytes > 0 && bytes < 4_000_000) {
        const text = readFileSync(abs, 'utf8');
        counts = countLines(text, def.comment);
      } else if (bytes >= 4_000_000) {
        // Skip line counting for very large files but still tally bytes.
        counts = { total: 0, code: 0, comment: 0, blank: 0 };
      }
    } catch {
      continue;
    }

    let acc = accs.get(def.id);
    if (!acc) {
      acc = {
        def,
        files: 0,
        bytes: 0,
        totalLines: 0,
        codeLines: 0,
        commentLines: 0,
        blankLines: 0,
        largest: null,
      };
      accs.set(def.id, acc);
    }
    acc.files++;
    acc.bytes += bytes;
    acc.totalLines += counts.total;
    acc.codeLines += counts.code;
    acc.commentLines += counts.comment;
    acc.blankLines += counts.blank;
    if (!acc.largest || bytes > acc.largest.bytes) {
      acc.largest = {
        path: nodePath.relative(projectRoot, abs).replace(/\\/g, '/'),
        bytes,
        lines: counts.total,
      };
    }

    allFiles.push({
      path: nodePath.relative(projectRoot, abs).replace(/\\/g, '/'),
      language: def.id,
      bytes,
      lines: counts.total,
    });
  }

  const byLanguage: IRepositoryStatsLanguage[] = [];
  for (const acc of accs.values()) {
    byLanguage.push({
      language: acc.def.id,
      extensions: acc.def.extensions,
      files: acc.files,
      bytes: acc.bytes,
      totalLines: acc.totalLines,
      codeLines: acc.codeLines,
      commentLines: acc.commentLines,
      blankLines: acc.blankLines,
      averageFileBytes: acc.files > 0 ? Math.round(acc.bytes / acc.files) : 0,
      averageFileLines: acc.files > 0 ? Math.round(acc.totalLines / acc.files) : 0,
      largestFile: acc.largest,
    });
  }
  byLanguage.sort((a, b) => b.files - a.files || b.bytes - a.bytes);

  const totals: IRepositoryStatsTotals = byLanguage.reduce(
    (acc, l) => ({
      files: acc.files + l.files,
      bytes: acc.bytes + l.bytes,
      totalLines: acc.totalLines + l.totalLines,
      codeLines: acc.codeLines + l.codeLines,
      commentLines: acc.commentLines + l.commentLines,
      blankLines: acc.blankLines + l.blankLines,
    }),
    { files: 0, bytes: 0, totalLines: 0, codeLines: 0, commentLines: 0, blankLines: 0 },
  );

  allFiles.sort((a, b) => b.bytes - a.bytes);
  const topFiles = allFiles.slice(0, Math.max(0, maxTop));

  return {
    schema: REPOSITORY_STATS_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    totals,
    byLanguage,
    topFiles,
    ignoredDirectories: [...IGNORED_DIR_NAMES].sort((a, b) => a.localeCompare(b)),
    truncated: walk.truncated,
  };
}
