import * as nodePath from 'node:path';
import { runGitLines } from '@shrkcrft/shared';

/**
 * CLI-side `--since <ref>` helper. Thin wrapper over a two-dot `git diff
 * --name-status <ref>` (working tree vs `<ref>`) that returns the changed file
 * set + a deleted file set + an `isAvailable` flag so callers can fall back
 * to whole-tree mode cleanly.
 *
 * Default ref resolution when `--since` is passed without a value:
 *   - `origin/main` if it resolves,
 *   - else `main` if it resolves,
 *   - else `undefined` (caller errors out).
 *
 * The function NEVER throws — git failures degrade to
 * `isAvailable: false` with an error message.
 */
export interface IChangedPaths {
  ref: string;
  changed: readonly string[];
  deleted: readonly string[];
  isAvailable: boolean;
  error?: string;
}

const DEFAULT_REF_CANDIDATES = ['origin/main', 'main', 'origin/master', 'master'];

const PER_PROCESS_CACHE = new Map<string, IChangedPaths>();

export function resolveDefaultSinceRef(cwd: string): string | undefined {
  for (const candidate of DEFAULT_REF_CANDIDATES) {
    if (runGitLines(cwd, ['rev-parse', '--verify', '--quiet', candidate]).ok) {
      return candidate;
    }
  }
  return undefined;
}

function toPosix(path: string): string {
  return nodePath.normalize(path).split(nodePath.sep).join('/');
}

/**
 * Split `git diff --name-status` lines into changed vs deleted POSIX paths.
 * Rename/copy detection is ON by default for `git diff`, so a rename emits a
 * TAB-separated `R<score>\t<old>\t<new>` (copy: `C<score>\t<old>\t<new>`) — the
 * status field is `R100`, not a bare letter. The old path of a RENAME is gone
 * (so the orphan check must treat it as deleted); a COPY keeps its source. Every
 * other status (A/M/T/…) carries a single path. Parsing the status by its first
 * letter + splitting on TAB is what makes a `git mv` that orphans an importer
 * visible to `check orphans` / `finish` instead of silently dropped.
 */
function parseNameStatus(lines: readonly string[]): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0]![0];
    if (code === 'D') {
      deleted.push(toPosix(parts[1]!));
    } else if ((code === 'R' || code === 'C') && parts.length >= 3) {
      // R<score>\t<old>\t<new> (rename) / C<score>\t<old>\t<new> (copy).
      if (code === 'R') deleted.push(toPosix(parts[1]!)); // old path renamed away
      changed.push(toPosix(parts[2]!)); // new path is added
    } else {
      changed.push(toPosix(parts[1]!));
    }
  }
  return { changed, deleted };
}

export function collectChangedPaths(opts: {
  cwd: string;
  ref?: string;
  /** Read the staged (index) diff instead of diffing against a ref. */
  staged?: boolean;
}): IChangedPaths {
  if (opts.staged) {
    const cacheKey = `${opts.cwd}::staged`;
    const cached = PER_PROCESS_CACHE.get(cacheKey);
    if (cached) return cached;
    const out = runGitLines(opts.cwd, ['diff', '--name-status', '--cached']);
    if (!out.ok) {
      return {
        ref: 'STAGED',
        changed: [],
        deleted: [],
        isAvailable: false,
        ...(out.error ? { error: out.error } : {}),
      };
    }
    const { changed, deleted } = parseNameStatus(out.lines);
    const result: IChangedPaths = { ref: 'STAGED', changed, deleted, isAvailable: true };
    PER_PROCESS_CACHE.set(cacheKey, result);
    return result;
  }

  const ref = opts.ref ?? resolveDefaultSinceRef(opts.cwd);
  if (!ref) {
    return {
      ref: '',
      changed: [],
      deleted: [],
      isAvailable: false,
      error: 'no resolvable default branch (tried origin/main, main, origin/master, master)',
    };
  }
  // Namespace the ref cache key so a branch/tag literally named `staged` can't
  // collide with the `::staged` index-diff key above.
  const cacheKey = `${opts.cwd}::ref::${ref}`;
  const cached = PER_PROCESS_CACHE.get(cacheKey);
  if (cached) return cached;

  // Two-dot diff against the ref to match the inspector's
  // `getChangedFiles({ since })` behavior — includes both committed
  // changes and the working tree relative to <ref>. `runGitLines` is
  // shell-free + high-maxBuffer, so a large changeset no longer ENOBUFS-crashes
  // the `impact --deleted` orphan check (this is its only write-safety guard).
  const out = runGitLines(opts.cwd, ['diff', '--name-status', ref]);
  if (!out.ok) {
    return {
      ref,
      changed: [],
      deleted: [],
      isAvailable: false,
      ...(out.error ? { error: out.error } : {}),
    };
  }
  const { changed, deleted } = parseNameStatus(out.lines);
  const result: IChangedPaths = { ref, changed, deleted, isAvailable: true };
  PER_PROCESS_CACHE.set(cacheKey, result);
  return result;
}
