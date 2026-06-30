import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';

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
  /** When set, only files under one of these globs are scanned. */
  include?: readonly string[];
}

export interface IImportEdge {
  /** Source file (relative to projectRoot). */
  from: string;
  /** Literal import specifier. */
  importSpecifier: string;
  /** Approximate 1-based line number in the source file. */
  line: number;
  /**
   * Heuristic resolution. v1 sets:
   *   - 'internal' if the specifier starts with './' or '../'
   *   - 'external' otherwise
   * (We do not attempt tsconfig path-mapping resolution here.)
   */
  kind: 'internal' | 'external';
}

export interface IImportScanResult {
  filesScanned: number;
  edges: IImportEdge[];
  warnings: string[];
}

// Match `import ... from 'x'`, `export ... from 'x'`, `require('x')`,
// `import('x')` (static and dynamic). Captures the specifier as group 1.
//
// We DELIBERATELY use a single regex per kind rather than a real parser —
// boundary rules need stable behavior across syntaxes and a regex scanner is
// the simplest thing that works for v1. Comments and string escapes can fool
// it; we filter the lowest-hanging fruit (single-line // and /* */ stripped
// per line, but a `// import "x"` line is still ignored).
const IMPORT_RE = /(?:^|\s)(?:import|export)\s+[^'"`]*?from\s+['"]([^'"`]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\s)import\s+['"]([^'"`]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"`]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"`]+)['"]\s*\)/g;

function isIgnored(name: string, extraIgnore: ReadonlySet<string>): boolean {
  if (DEFAULT_IGNORE.has(name)) return true;
  if (extraIgnore.has(name)) return true;
  if (name.startsWith('.')) return name !== '.';
  return false;
}

function* walk(
  root: string,
  current: string,
  extraIgnore: ReadonlySet<string>,
): Iterable<string> {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
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
      const ext = nodePath.extname(name);
      if (!SUPPORTED_EXTS.has(ext)) continue;
      yield full;
    }
  }
}

function lineFor(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function extractImports(source: string, relPath: string): IImportEdge[] {
  const edges: IImportEdge[] = [];
  for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1]!;
      const line = lineFor(source, m.index);
      edges.push({
        from: relPath,
        importSpecifier: spec,
        line,
        kind: spec.startsWith('.') ? 'internal' : 'external',
      });
    }
  }
  return edges;
}

/**
 * Walk the project root and return every detected import edge.
 */
export function scanImports(options: IScanImportsOptions): IImportScanResult {
  const root = nodePath.resolve(options.projectRoot);
  const extraIgnore = new Set(options.extraIgnore ?? []);
  const result: IImportScanResult = {
    filesScanned: 0,
    edges: [],
    warnings: [],
  };
  if (!existsSync(root)) {
    result.warnings.push(`scan root does not exist: ${root}`);
    return result;
  }
  for (const file of walk(root, root, extraIgnore)) {
    result.filesScanned += 1;
    const rel = nodePath.relative(root, file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch (e) {
      result.warnings.push(`unreadable: ${rel} (${(e as Error).message})`);
      continue;
    }
    result.edges.push(...extractImports(source, rel));
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
