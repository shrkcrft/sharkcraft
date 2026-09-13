import * as nodePath from 'node:path';

/**
 * Every extension the code graph builds a File node for. The ONE list — read
 * through {@link isGraphSourcePath} / {@link isGraphIndexablePath}.
 */
const GRAPH_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  // Web component formats — parsed by framework-scanners; the TS-AST
  // extractor short-circuits on these.
  '.vue', '.svelte', '.astro',
  // Non-TS languages — handled by the per-language dispatcher.
  '.py', '.go', '.java', '.rs', '.kt', '.kts', '.rb', '.cs', '.csx', '.ex', '.exs', '.php',
  '.dart', '.swift',
  // Schema-definition formats — File nodes only; framework-scanners
  // does the SDL parsing.
  '.graphql', '.gql',
]);

/**
 * Directory names the code graph's walk never enters — dependencies, build
 * output, caches, the graph's own store. The ONE list: the full index builder,
 * the freshness walk (`detectGraphFreshness`), the incremental updater and the
 * orphan check's coverage all read it through {@link isGraphWalkSkipped} /
 * {@link isGraphIndexablePath}. (It used to live privately in the index
 * builder, with a second copy in the freshness walk, so the orphan check's
 * "would the index know this file?" answered by extension alone and a deleted
 * `dist/x.js` read as a permanent gap.)
 */
export const GRAPH_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.sharkcraft',
  '.next',
  '.cache',
  '.tmp-pack',
  'out',
  'target',
]);

/**
 * True when the graph's walk skips a directory entry named `name`: a
 * {@link GRAPH_SKIP_DIRS} name, a caller's extra ignore, or any dot-name. The
 * per-entry rule every graph walk applies — to directories and files alike.
 */
export function isGraphWalkSkipped(name: string, extraIgnore?: ReadonlySet<string>): boolean {
  if (GRAPH_SKIP_DIRS.has(name)) return true;
  if (extraIgnore !== undefined && extraIgnore.has(name)) return true;
  return name.startsWith('.') && name !== '.';
}

/**
 * True when the code graph indexes a file with this extension. Only half of
 * "would the index know this file?" — directory skips are the other half, so a
 * caller asking about a concrete path wants {@link isGraphIndexablePath}.
 */
export function isGraphSourcePath(path: string): boolean {
  return GRAPH_SOURCE_EXTENSIONS.has(nodePath.extname(path).toLowerCase());
}

/**
 * True when the code graph INDEXES the file at project-relative `relPath`: an
 * indexed extension AND no path segment the walk skips ({@link
 * isGraphWalkSkipped}, with the builder's `extraIgnore` when one was used).
 * THE answer to "would the index know this file?": `check orphans` scopes its
 * coverage by it (a deleted `dist/x.js` is out of scope, never a gap no
 * re-index can clear), and the incremental updater gates on it so it never
 * indexes a file the full build would skip. A path outside the root (`..`) is
 * never indexable.
 */
export function isGraphIndexablePath(relPath: string, extraIgnore?: readonly string[]): boolean {
  const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) return false;
  const extra = extraIgnore !== undefined && extraIgnore.length > 0 ? new Set(extraIgnore) : undefined;
  if (segments.some((s) => isGraphWalkSkipped(s, extra))) return false;
  return isGraphSourcePath(relPath);
}
