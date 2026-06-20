import * as nodePath from 'node:path';
import { TtlFileCcrStore } from '@shrkcrft/compress';

/**
 * Upper bound on cached CCR originals under `.sharkcraft/ccr/`. The store evicts
 * the oldest entries past this on every `put`, so the compress cache stays
 * bounded instead of growing without limit (the old `FileCcrStore` had no cap).
 * Count-based (not time-based) so a previously-cached key never silently
 * expires out from under a `shrk expand` until it is genuinely the oldest and
 * the cap is exceeded.
 */
export const CCR_MAX_ENTRIES = 1000;

/** Absolute path to the per-workspace CCR cache directory. */
export function ccrDir(cwd: string): string {
  return nodePath.join(cwd, '.sharkcraft', 'ccr');
}

/**
 * Open the bounded, cross-process CCR store the CLI write/read paths share.
 * `ttlMs: 0` means no time expiry; `maxEntries` is the only bound.
 */
export function openCcrStore(cwd: string): TtlFileCcrStore {
  return new TtlFileCcrStore(ccrDir(cwd), { maxEntries: CCR_MAX_ENTRIES });
}
