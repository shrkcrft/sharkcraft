import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { matchesAny } from '../scan/glob.ts';

/** Vendor / build / VCS dirs never scanned. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.sharkcraft',
  '.next',
  '.turbo',
  '.cache',
]);

/** Files larger than this are skipped (regex token extraction over multi-MB blobs is pointless). */
export const MAX_SCAN_FILE_BYTES = 1_000_000;

/**
 * Walk `root`, returning project-relative POSIX paths that match any glob.
 * `excludeDirs` is a set of project-relative POSIX directory paths to prune
 * entirely (e.g. the SharkCraft asset/config dir).
 */
export function walkMatching(
  root: string,
  globs: readonly string[],
  excludeDirs: ReadonlySet<string> = new Set(),
  allowDotDirs: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childAbs = nodePath.join(abs, e.name);
      const rel = nodePath.relative(root, childAbs).split(nodePath.sep).join('/');
      if (e.isDirectory()) {
        // Skip vendor/build/VCS dirs AND every dot-directory (`.yarn`, `.pnp`,
        // `.venv`, `.gradle`, …) — matching the established scan-imports walker,
        // so neither policy-lint nor wiring scans tooling/vendored sources.
        // (Dirent.isDirectory() is false for symlinks, so symlinked dirs are
        // never descended — no loop risk.)
        // Dot-directories are vendored tooling by default (`.venv`, `.yarn`,
        // `.gradle`). But a rule may legitimately target one — an agent skill
        // file lives in `.claude/skills` — so a caller can name the dot-dirs
        // its OWN globs ask for. `SKIP_DIRS` stays absolute either way.
        if (SKIP_DIRS.has(e.name) || excludeDirs.has(rel)) continue;
        if (e.name.startsWith('.') && !allowDotDirs.has(e.name)) continue;
        visit(childAbs);
      } else if (e.isFile()) {
        if (matchesAny(rel, globs)) out.push(rel);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * Memo of `readMatchingFiles`, keyed by (root, glob set, excludes).
 *
 * One coverage run resolves the SAME globs many times over: every rule on every
 * plane walks the tree for its own sources, and a shared `$use` extractor is by
 * construction read once per consumer. The walk + read is roughly half the cost
 * of a wide extraction, so memoizing turns N walks into one.
 *
 * It is OFF by default and enabled only by {@link withFileReadCache}, around a
 * scan that provably neither spawns nor writes. That restriction is not
 * caution for its own sake — a global memo really does hand back a stale
 * snapshot when the same process writes a file between two scans, and a trust
 * tool answering "nothing drifted" from a stale read is worse than a slow one.
 * Making the safe window explicit means the condition cannot be forgotten at a
 * call site.
 */
const READ_MEMO = new Map<string, Map<string, string>>();

/** True only inside {@link withFileReadCache}. */
let memoEnabled = false;

/**
 * Run `fn` with the read memo enabled, then clear it.
 *
 * ONLY wrap a scan that performs no writes and spawns no commands for its
 * duration — within such a window the tree cannot change beneath the memo, so
 * reuse is exact rather than merely probable.
 */
export function withFileReadCache<T>(fn: () => T): T {
  const previous = memoEnabled;
  memoEnabled = true;
  try {
    return fn();
  } finally {
    memoEnabled = previous;
    if (!previous) READ_MEMO.clear();
  }
}

/** Drop every memoized read. For tests, and for a caller that has just written. */
export function clearFileReadCache(): void {
  READ_MEMO.clear();
}


/**
 * The dot-directory segments a glob set explicitly names.
 *
 * `.claude/skills/**` asks for `.claude`; `docs/**` asks for nothing. Deriving
 * the allowlist from the globs themselves means a rule gets exactly the
 * directories it named and no others — a blanket "scan dot-dirs" switch would
 * wander into `.venv` and `.yarn` the moment someone wrote a recursive glob.
 */
export function dotDirsNamedBy(globs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const glob of globs) {
    for (const segment of glob.split('/')) {
      if (segment.startsWith('.') && segment.length > 1 && !segment.includes('*') && !segment.includes('?')) {
        out.add(segment);
      }
    }
  }
  return out;
}

/** Walk + read every file matching `globs`, skipping oversized/unreadable files. */
export function readMatchingFiles(
  root: string,
  globs: readonly string[],
  excludeDirs: ReadonlySet<string> = new Set(),
  allowDotDirs: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const key = memoEnabled
    ? `${root}\u0000${[...globs].sort().join('\u0001')}\u0000${[...excludeDirs].sort().join('\u0001')}` +
      `\u0000${[...allowDotDirs].sort().join('\u0001')}`
    : undefined;
  if (key !== undefined) {
    const hit = READ_MEMO.get(key);
    // Hand back a COPY: callers routinely mutate the map they get (the wiring
    // scan filters it, the generated scan partitions it), and a shared instance
    // would let one rule's bookkeeping corrupt the next rule's inputs.
    if (hit) return new Map(hit);
  }
  const out = new Map<string, string>();
  for (const rel of walkMatching(root, globs, excludeDirs, allowDotDirs)) {
    const abs = nodePath.join(root, rel);
    let size = -1;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size > MAX_SCAN_FILE_BYTES) continue;
    try {
      out.set(rel, readFileSync(abs, 'utf8'));
    } catch {
      // unreadable — skip
    }
  }
  if (key !== undefined) READ_MEMO.set(key, new Map(out));
  return out;
}
