import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

export const SIGNATURE_CACHE_SCHEMA = 'sharkcraft.api-surface-cache/v1' as const;
const CACHE_REL = '.sharkcraft/api-surface/signatures.json';

/**
 * Per-file entry. `sha1` is the SHA1 of the source file's contents at
 * the time the cache was written. `signatures` maps `symbol-name +
 * isDefault` (within that file) to its canonical signature string.
 *
 * We key signatures within a file by `${name}|${isDefault?1:0}` rather
 * than by global symbol id so the cache survives file renames (a file
 * rename invalidates the SHA1 anyway, so the cache misses on the old
 * file but the new file builds fresh).
 */
export interface ISignatureCacheFileEntry {
  /** SHA1 of file contents when the cache was written. */
  sha1: string;
  /** keyed by `${name}|${isDefault?1:0}`. */
  signatures: Readonly<Record<string, string>>;
}

export interface ISignatureCache {
  schema: typeof SIGNATURE_CACHE_SCHEMA;
  generatedAt: string;
  /** Workspace-relative POSIX paths → per-file cache entry. */
  files: Readonly<Record<string, ISignatureCacheFileEntry>>;
}

export function emptyCache(): ISignatureCache {
  return {
    schema: SIGNATURE_CACHE_SCHEMA,
    generatedAt: new Date().toISOString(),
    files: {},
  };
}

export function loadSignatureCache(projectRoot: string): ISignatureCache {
  const abs = nodePath.join(projectRoot, CACHE_REL);
  if (!existsSync(abs)) return emptyCache();
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as ISignatureCache;
    if (raw.schema !== SIGNATURE_CACHE_SCHEMA) return emptyCache();
    return raw;
  } catch {
    // Corrupted cache — treat as cold start. The next write will overwrite.
    return emptyCache();
  }
}

export function saveSignatureCache(projectRoot: string, cache: ISignatureCache): void {
  const abs = nodePath.join(projectRoot, CACHE_REL);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  const stamped: ISignatureCache = {
    ...cache,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(abs, JSON.stringify(stamped, null, 2), 'utf8');
}

export function symbolCacheKey(name: string, isDefault: boolean): string {
  return `${name}|${isDefault ? 1 : 0}`;
}

/**
 * Lightweight content fingerprint. Used to invalidate cached
 * signatures when a source file changes. Mirrors `@shrkcrft/graph`'s
 * fingerprint algorithm so the two stores agree on file identity.
 */
export function fingerprintContent(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}
