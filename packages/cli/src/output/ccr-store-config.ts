import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { TtlFileCcrStore } from '@shrkcrft/compress';

/**
 * Walk up from `cwd` to the nearest ancestor containing a `.sharkcraft/` dir
 * (the project root), so `compress` and `expand` share ONE cache per project —
 * a `<<ccr:KEY>>` cached at the repo root stays recoverable from any subdir
 * instead of being unrecoverable because `expand` looked in `<subdir>/.sharkcraft/ccr`.
 * Falls back to `cwd` when no project root is found (a fresh repo).
 */
function ccrRoot(cwd: string): string {
  let dir = nodePath.resolve(cwd);
  for (;;) {
    if (existsSync(nodePath.join(dir, '.sharkcraft'))) return dir;
    const parent = nodePath.dirname(dir);
    if (parent === dir) return cwd; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Upper bound on cached CCR originals under `.sharkcraft/ccr/`. The store evicts
 * the oldest entries past this on every `put`, so the compress cache stays
 * bounded instead of growing without limit (the old `FileCcrStore` had no cap).
 * Count-based (not time-based) so a previously-cached key never silently
 * expires out from under a `shrk expand` until it is genuinely the oldest and
 * the cap is exceeded.
 */
export const CCR_MAX_ENTRIES = 1000;

/** Absolute path to the per-project CCR cache directory (project-root-relative). */
export function ccrDir(cwd: string): string {
  return nodePath.join(ccrRoot(cwd), '.sharkcraft', 'ccr');
}

/**
 * Open the bounded, cross-process CCR store the CLI write/read paths share.
 * `ttlMs: 0` means no time expiry; `maxEntries` is the only bound.
 */
export function openCcrStore(cwd: string): TtlFileCcrStore {
  return new TtlFileCcrStore(ccrDir(cwd), { maxEntries: CCR_MAX_ENTRIES });
}
