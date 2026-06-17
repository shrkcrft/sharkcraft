import type { ICcrEntry } from './ccr-entry.ts';

/**
 * Storage contract for cached originals. Implementations may be in-memory
 * (MCP server lifetime — never touches disk, honouring "MCP never writes")
 * or filesystem-backed (CLI, under `.sharkcraft/ccr/`). Reads are total;
 * writes are idempotent on the content key.
 */
export interface ICcrStore {
  /** Cache `content`, returning its deterministic key. Idempotent. */
  put(content: string): string;
  /** Fetch a cached original by key, or `undefined` if absent/evicted. */
  get(key: string): ICcrEntry | undefined;
  /** Whether `key` is currently cached. */
  has(key: string): boolean;
  /** Number of cached entries. */
  size(): number;
}
