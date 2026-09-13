import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { globListWalkGlobs, globMayMatchUnder, matchesAny } from '../scan/glob.ts';
import type { IMatchedFiles } from './matched-files.ts';
import type { IUnreadFile } from './unread-file.ts';
import { UnreadFileReason } from './unread-file-reason.ts';

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

/**
 * Files larger than this are not READ (regex token extraction over multi-MB
 * blobs is pointless). They are still MATCHED: `readMatchingFiles` reports
 * each one as unread, and every coverage record counts it as unexamined.
 */
export const MAX_SCAN_FILE_BYTES = 1_000_000;

/**
 * The cap on one file of a REGENERATED temp tree (`generated check` /
 * `generated update`): a runaway regen must not be read into memory whole. A
 * file over it is reported unread (`UnreadFileReason.OverRegenCap`) by
 * `readRegenTree`, never dropped.
 */
export const MAX_REGEN_FILE_BYTES = 2_000_000;

/**
 * THE rule for which directories the walk never enters: a vendor/build/VCS
 * dir (`SKIP_DIRS`, absolute), an `excludeDirs` entry (project-relative), or a
 * dot-directory the caller's globs did not name (`allowDotDirs`).
 *
 * A file under a skipped directory is outside every plane's scope by design,
 * and is neither read nor reported unread. Anything that asks "would the walk
 * reach this path?" must ask this predicate; it must not keep its own copy of
 * the list. (Round 11: run-policy used to re-derive it to guess which unread
 * changed paths were in scope. It now reads the reader's own unread list.)
 */
export function walkSkipsDirectory(
  name: string,
  relPath: string,
  excludeDirs: ReadonlySet<string>,
  allowDotDirs: ReadonlySet<string> = new Set(),
): boolean {
  if (SKIP_DIRS.has(name) || excludeDirs.has(relPath)) return true;
  return name.startsWith('.') && !allowDotDirs.has(name);
}

/**
 * Walk `root`, returning project-relative POSIX paths that match any INCLUSION
 * glob. `excludeDirs` is a set of project-relative POSIX directory paths to
 * prune entirely (e.g. the SharkCraft asset/config dir).
 *
 * A walk is a POSITIVE union primitive: a `!` entry is dropped here, never
 * applied. Planes walk the union of many rules' lists once, and a negation
 * applied to that union would delete rule A's `!x` from rule B's scope — a
 * silent under-selection. Each list's negations subtract per list, after the
 * walk, through `globListSelects` (or `readSelectedFiles` for one list).
 *
 * `unlistedDirs`, when given, collects every directory the walk entered but
 * could not LIST (a permission error — not a directory that vanished), as a
 * project-relative path ending in `/` (the root is `./`). Every file beneath
 * one was never matched; `readMatchingFiles` reports it unread rather than
 * letting its files drop out of every rule's scope in silence.
 */
export function walkMatching(
  root: string,
  globs: readonly string[],
  excludeDirs: ReadonlySet<string> = new Set(),
  allowDotDirs: ReadonlySet<string> = new Set(),
  unlistedDirs?: string[],
): string[] {
  const walkGlobs = globListWalkGlobs(globs);
  const out: string[] = [];
  const visit = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (unlistedDirs && code !== 'ENOENT' && code !== 'ENOTDIR') {
        const rel = nodePath.relative(root, abs).split(nodePath.sep).join('/');
        unlistedDirs.push(rel === '' ? './' : `${rel}/`);
      }
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
        if (walkSkipsDirectory(e.name, rel, excludeDirs, allowDotDirs)) continue;
        visit(childAbs);
      } else if (e.isFile()) {
        if (matchesAny(rel, walkGlobs)) out.push(rel);
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
const READ_MEMO = new Map<string, IMatchedFiles>();

/** True only inside {@link withFileReadCache}. */
let memoEnabled = false;
/** Tree walks `readMatchingFiles` performed, and walks the memo served (tests / perf locks). */
let walkCount = 0;
let readMemoHits = 0;

/** How many times `readMatchingFiles` walked + read the tree, and how many calls the memo served. */
export function readMatchingFilesStats(): { readonly walks: number; readonly memoHits: number } {
  return { walks: walkCount, memoHits: readMemoHits };
}

/** Reset {@link readMatchingFilesStats}. */
export function resetReadMatchingFilesStats(): void {
  walkCount = 0;
  readMemoHits = 0;
}

/**
 * Run `fn` with the read memo enabled, then clear it.
 *
 * ONLY wrap a scan that performs no writes of its own for its duration. A
 * command the scan SPAWNS (a baseline's `compute.run`, a generated artifact's
 * `regen`) may rewrite files, so every spawn site calls
 * {@link clearFileReadCache} right after the child exits: a read after the
 * spawn is then fresh, and reuse inside the window stays exact rather than
 * merely probable.
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
  // Only an inclusion glob can put a file in scope, so only it opens a dot-dir.
  for (const glob of globListWalkGlobs(globs)) {
    for (const segment of glob.split('/')) {
      if (segment.startsWith('.') && segment.length > 1 && !segment.includes('*') && !segment.includes('?')) {
        out.add(segment);
      }
    }
  }
  return out;
}

/**
 * THE reader: walk + read every file matching `globs`.
 *
 * Returns the files it read AND the matched files it did not read (over
 * {@link MAX_SCAN_FILE_BYTES}, or unreadable), each with its reason. It used
 * to drop those silently. Every plane then counted its expected scope from
 * what was read, so an over-cap file holding a forbidden token read
 * "examined 1 of 1 ✓". Now the gap is part of the return value, and every
 * engine folds it into its rule coverage through `readScopeCoverage`.
 *
 * A path deleted between the walk and the stat is no longer in scope and is
 * not reported.
 *
 * POSITIVE-ONLY, like {@link walkMatching}: a `!` entry in `globs` never
 * subtracts here, because callers hand this the union of many lists. The
 * result is every file an inclusion glob matched; a caller reading ONE list
 * selects through `readSelectedFiles`, a caller reading many filters each
 * list with `globListSelects` / `unreadMatching`.
 */
export function readMatchingFiles(
  root: string,
  globs: readonly string[],
  excludeDirs: ReadonlySet<string> = new Set(),
  allowDotDirs: ReadonlySet<string> = new Set(),
): IMatchedFiles {
  // `['src/**', '!src/x.ts']` and `['src/**']` are one walk, so one memo entry.
  const walkGlobs = globListWalkGlobs(globs);
  const key = memoEnabled
    ? `${root}\u0000${[...walkGlobs].sort().join('\u0001')}\u0000${[...excludeDirs].sort().join('\u0001')}` +
      `\u0000${[...allowDotDirs].sort().join('\u0001')}`
    : undefined;
  if (key !== undefined) {
    const hit = READ_MEMO.get(key);
    // Hand back a COPY of the map: callers routinely mutate the one they get
    // (the wiring scan filters it, the generated scan partitions it), and a
    // shared instance would let one rule's bookkeeping corrupt the next
    // rule's inputs. The unread list is frozen, so it is shared as is.
    if (hit) {
      readMemoHits += 1;
      return { files: new Map(hit.files), unread: hit.unread };
    }
  }
  walkCount += 1;
  const files = new Map<string, string>();
  const unread: IUnreadFile[] = [];
  const unlistedDirs: string[] = [];
  const matchedPaths = walkMatching(root, walkGlobs, excludeDirs, allowDotDirs, unlistedDirs);
  // A directory the walk could not list hides every file beneath it. It is in
  // front of any glob that could match there, so it is reported unread (the
  // rule over that tree settles PARTIAL), never dropped from scope in silence.
  // Only an inclusion glob can be in front of it: `!**/x` has a `**` segment,
  // but a negation selects nothing on its own.
  for (const dir of unlistedDirs) {
    if (walkGlobs.some((g) => globMayMatchUnder(g, dir))) {
      unread.push({ path: dir, reason: UnreadFileReason.UnreadableDirectory });
    }
  }
  for (const rel of matchedPaths) {
    const abs = nodePath.join(root, rel);
    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch (e) {
      // Deleted since the walk saw it: gone, so out of scope. Anything else
      // (a permission error) leaves a matched file unexamined.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        unread.push({ path: rel, reason: UnreadFileReason.Unreadable });
      }
      continue;
    }
    if (size > MAX_SCAN_FILE_BYTES) {
      unread.push({ path: rel, reason: UnreadFileReason.OverReadCap, bytes: size });
      continue;
    }
    try {
      files.set(rel, readFileSync(abs, 'utf8'));
    } catch {
      unread.push({ path: rel, reason: UnreadFileReason.Unreadable, bytes: size });
    }
  }
  unread.sort((a, b) => a.path.localeCompare(b.path));
  const result: IMatchedFiles = { files, unread: Object.freeze(unread) };
  if (key !== undefined) READ_MEMO.set(key, { files: new Map(files), unread: result.unread });
  return result;
}
