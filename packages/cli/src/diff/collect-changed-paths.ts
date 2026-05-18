import { execSync } from 'node:child_process';
import * as nodePath from 'node:path';

/**
 * CLI-side `--since <ref>` helper. Thin wrapper over `git diff
 * --name-status <ref>...HEAD` that returns the changed file set + a
 * deleted file set + an `isAvailable` flag so callers can fall back
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
    try {
      execSync(`git -C "${cwd}" rev-parse --verify --quiet "${candidate}"`, {
        stdio: 'pipe',
      });
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

export function collectChangedPaths(opts: {
  cwd: string;
  ref?: string;
}): IChangedPaths {
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
  const cacheKey = `${opts.cwd}::${ref}`;
  const cached = PER_PROCESS_CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    // Two-dot diff against the ref to match the inspector's
    // `getChangedFiles({ since })` behavior — includes both committed
    // changes and the working tree relative to <ref>.
    const stdout = execSync(
      `git -C "${opts.cwd}" diff --name-status "${ref}"`,
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
    const changed: string[] = [];
    const deleted: string[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\w)\s+(.+)$/);
      if (!m) continue;
      const [, status, path] = m;
      const norm = nodePath.normalize(path!).split(nodePath.sep).join('/');
      if (status === 'D') deleted.push(norm);
      else changed.push(norm);
    }
    const result: IChangedPaths = { ref, changed, deleted, isAvailable: true };
    PER_PROCESS_CACHE.set(cacheKey, result);
    return result;
  } catch (e) {
    return {
      ref,
      changed: [],
      deleted: [],
      isAvailable: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
