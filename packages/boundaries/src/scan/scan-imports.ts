import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { parseImportStatements } from '../extract/parse-imports.ts';
import type { IUnreadFile } from '../util/unread-file.ts';
import { UnreadFileReason } from '../util/unread-file-reason.ts';
import { globMayMatchUnder, matchesAny } from './glob.ts';

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const DEFAULT_IGNORE = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.sharkcraft',
  '.next',
  '.cache',
  '.tmp-pack',
  '.tmp-smoke-consumer.txt',
]);

export interface IScanImportsOptions {
  projectRoot: string;
  extraIgnore?: readonly string[];
  /** When set, only files matching one of these globs (project-relative) are scanned. */
  include?: readonly string[];
  /**
   * Read imports from the RAW text, comments included (`check boundaries
   * --include-comments`). Default `false`: a commented-out import, an import in
   * a doc-comment code fence, or one inside a string literal is not an edge.
   */
  includeComments?: boolean;
}

export interface IImportEdge {
  /** Source file (relative to projectRoot, `/`-separated). */
  from: string;
  /** Literal import specifier. */
  importSpecifier: string;
  /** 1-based line of the statement's `import` / `export` / `require` keyword. */
  line: number;
  /**
   * Heuristic resolution. v1 sets:
   *   - 'internal' if the specifier starts with './' or '../'
   *   - 'external' otherwise
   * (We do not attempt tsconfig path-mapping resolution here.)
   */
  kind: 'internal' | 'external';
  /** True for `import type` / `export type … from` — still a real dependency edge. */
  typeOnly?: boolean;
}

export interface IImportScanResult {
  filesScanned: number;
  edges: IImportEdge[];
  warnings: string[];
  /**
   * Every scanned source file (project-relative, `/`-separated), INCLUDING files
   * with zero imports. A rule's scope is counted against this list, so a glob
   * that matches only import-free files is still live. Optional for callers
   * that hand-build a scan; the evaluator then falls back to the files that
   * appear in `edges` (and says so in its coverage).
   */
  files?: string[];
  /**
   * Source files the walk matched but could NOT read (a stat or read failure —
   * permissions, or a file vanishing mid-scan), with the reason. They are NOT
   * in `files` and NOT counted in `filesScanned`: a file whose imports were
   * never read was not scanned. `runBoundaryCheck` folds each one into the
   * coverage of every rule whose scope it is in (`readScopeCoverage`), so a
   * rule over an unreadable file settles PARTIAL (2) — never "examined 1 of 1"
   * over the file that held the violation.
   */
  unread?: IUnreadFile[];
  /** Every `package.json` the walk passed (project-relative) — workspace package names. */
  manifestFiles?: string[];
  /** Which text the edges were read from. */
  zone?: 'code' | 'all';
}

function isIgnored(name: string, extraIgnore: ReadonlySet<string>): boolean {
  if (DEFAULT_IGNORE.has(name)) return true;
  if (extraIgnore.has(name)) return true;
  if (name.startsWith('.')) return name !== '.';
  return false;
}

/**
 * A path the walk yields: a source file to scan, a manifest to record, or a
 * directory it could not LIST (`unlistable`, with the error) — every source
 * beneath that one was never matched, so it is reported, never skipped.
 */
interface IWalkHit {
  readonly full: string;
  readonly manifest: boolean;
  readonly unlistable?: string;
}

function* walk(
  root: string,
  current: string,
  extraIgnore: ReadonlySet<string>,
): Iterable<IWalkHit> {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch (e) {
    // A directory that vanished mid-walk is out of scope; one that could not
    // be listed (permissions) is in front of every rule that reaches under it.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      yield { full: current, manifest: false, unlistable: (e as Error).message };
    }
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    if (isIgnored(name, extraIgnore)) continue;
    // Do NOT descend into (or yield through) symlinks. Following a symlinked
    // directory can inject phantom files into the graph — a self-referential
    // loop (`src/loop -> src` => `src/loop/loop/loop/...`) only self-terminates
    // by accident at PATH_MAX, and a link to a large external tree gets fully
    // scanned. Mirror detect-workspace.ts's isTraversableDir pruning.
    if (entry.isSymbolicLink()) continue;
    const full = nodePath.join(current, name);
    if (entry.isDirectory()) {
      yield* walk(root, full, extraIgnore);
      continue;
    }
    if (entry.isFile()) {
      if (name === 'package.json') {
        yield { full, manifest: true };
        continue;
      }
      const ext = nodePath.extname(name);
      if (!SUPPORTED_EXTS.has(ext)) continue;
      yield { full, manifest: false };
    }
  }
}

/**
 * Per-process memo of the edges ONE file contributes, keyed on scan root + file
 * + zone and validated by a stat fingerprint (size, mtime, ctime).
 *
 * `scanImports` runs several times per command — the architecture map calls it
 * twice and impact analysis once for a single task-risk report — and for the
 * whole life of the MCP server. Round 11's comment-aware parse (lex → blank
 * comments → match) made re-reading and re-lexing every unchanged file on every
 * call the dominant cost of those reports (~3x). An edited file changes its
 * fingerprint and is re-parsed; an unchanged one is not. Edges are handed out
 * as COPIES so a caller that decorates an edge can never corrupt the memo.
 */
const EDGE_MEMO = new Map<string, { readonly fingerprint: string; readonly edges: readonly IImportEdge[] }>();
const EDGE_MEMO_LIMIT = 50_000;

/** Drop every memoised file (tests, or a caller that rewrote files in place within one tick). */
export function clearImportScanMemo(): void {
  EDGE_MEMO.clear();
}

function toPosix(rel: string): string {
  return nodePath.sep === '/' ? rel : rel.split(nodePath.sep).join('/');
}

/**
 * The edges one file contributes — read through THE import parser
 * (`parseImportStatements`), so `check boundaries` and the `import-edges` DSL
 * extractor can never disagree about what a file imports. (Round 11 deleted the
 * four private regexes that used to live here, together with a comment that
 * claimed they stripped comments: no stripping code existed, a commented-out
 * import was a violation, and every import after line 1 was reported one line
 * early.)
 */
function extractImports(source: string, relPath: string, zone: 'code' | 'all'): IImportEdge[] {
  return parseImportStatements(source, { zone }).map((p) => ({
    from: relPath,
    importSpecifier: p.specifier,
    line: p.line,
    kind: p.specifier.startsWith('.') ? 'internal' : 'external',
    ...(p.typeOnly ? { typeOnly: true } : {}),
  }));
}

/**
 * Walk the project root and return every detected import edge.
 */
export function scanImports(options: IScanImportsOptions): IImportScanResult {
  const root = nodePath.resolve(options.projectRoot);
  const extraIgnore = new Set(options.extraIgnore ?? []);
  const zone: 'code' | 'all' = options.includeComments === true ? 'all' : 'code';
  const include = options.include && options.include.length > 0 ? options.include : undefined;
  const result: IImportScanResult = {
    filesScanned: 0,
    edges: [],
    warnings: [],
    files: [],
    unread: [],
    manifestFiles: [],
    zone,
  };
  if (!existsSync(root)) {
    result.warnings.push(`scan root does not exist: ${root}`);
    return result;
  }
  // A file counts as SCANNED only once its imports were actually read (or
  // served from the memo). It used to be counted — and listed in `files`, the
  // universe every rule's scope is measured against — before the read, so an
  // unreadable file read as "examined 1 of 1" while its imports were never seen.
  const unreadable = (rel: string, e: unknown): void => {
    result.warnings.push(`unreadable: ${rel} (${(e as Error).message})`);
    result.unread!.push({ path: rel, reason: UnreadFileReason.Unreadable });
  };
  for (const hit of walk(root, root, extraIgnore)) {
    const rel = toPosix(nodePath.relative(root, hit.full));
    if (hit.unlistable !== undefined) {
      const dir = rel === '' ? './' : `${rel}/`;
      if (include && !include.some((g) => globMayMatchUnder(g, dir))) continue;
      result.warnings.push(`unlistable directory: ${dir} (${hit.unlistable})`);
      result.unread!.push({ path: dir, reason: UnreadFileReason.UnreadableDirectory });
      continue;
    }
    if (hit.manifest) {
      result.manifestFiles!.push(rel);
      continue;
    }
    if (include && !matchesAny(rel, include)) continue;
    let fingerprint: string;
    try {
      const st = statSync(hit.full);
      fingerprint = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch (e) {
      // Deleted since the walk saw it: gone, so out of scope (the one reader's
      // rule, `readMatchingFiles`). Anything else leaves it unexamined.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable(rel, e);
      continue;
    }
    const key = `${root}\0${hit.full}\0${zone}`;
    const memo = EDGE_MEMO.get(key);
    if (memo && memo.fingerprint === fingerprint) {
      result.filesScanned += 1;
      result.files!.push(rel);
      for (const e of memo.edges) result.edges.push({ ...e });
      continue;
    }
    let source: string;
    try {
      source = readFileSync(hit.full, 'utf8');
    } catch (e) {
      unreadable(rel, e);
      continue;
    }
    result.filesScanned += 1;
    result.files!.push(rel);
    const edges = extractImports(source, rel, zone);
    if (EDGE_MEMO.size >= EDGE_MEMO_LIMIT) EDGE_MEMO.clear();
    EDGE_MEMO.set(key, { fingerprint, edges });
    for (const e of edges) result.edges.push({ ...e });
  }
  return result;
}

/**
 * Aggregate summary for `shrk graph imports` / MCP get_import_graph_summary.
 */
export interface IImportGraphSummary {
  filesScanned: number;
  totalImports: number;
  internalImports: number;
  externalImports: number;
  topExternalSpecifiers: readonly { specifier: string; count: number }[];
  warnings: readonly string[];
}

export function summarizeImports(scan: IImportScanResult): IImportGraphSummary {
  const externalCounts = new Map<string, number>();
  let internal = 0;
  for (const e of scan.edges) {
    if (e.kind === 'internal') internal += 1;
    else externalCounts.set(e.importSpecifier, (externalCounts.get(e.importSpecifier) ?? 0) + 1);
  }
  const top = [...externalCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([specifier, count]) => ({ specifier, count }));
  return {
    filesScanned: scan.filesScanned,
    totalImports: scan.edges.length,
    internalImports: internal,
    externalImports: scan.edges.length - internal,
    topExternalSpecifiers: top,
    warnings: scan.warnings,
  };
}
