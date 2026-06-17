import { Buffer } from 'node:buffer';
import type { ICcrStore } from './ccr-store.ts';
import type { ICcrEntry } from './ccr-entry.ts';
import { ccrKey } from './ccr-key.ts';

/**
 * In-memory CCR backend. Used by the MCP server, whose process is long-lived,
 * so a `compress_context` call and a later `retrieve_original` call in the
 * same session share one store. Holding originals in memory (never on disk)
 * keeps the MCP-never-writes contract intact.
 *
 * Bounded by an insertion-order capacity: when full, the oldest entry is
 * evicted (a retrieval miss just means the agent re-runs the producing call).
 */
export class InMemoryCcrStore implements ICcrStore {
  private readonly entries = new Map<string, ICcrEntry>();
  private readonly capacity: number;

  constructor(capacity = 512) {
    // No logic beyond field init — capacity is a plain bound.
    this.capacity = capacity > 0 ? capacity : 512;
  }

  put(content: string): string {
    const key = ccrKey(content);
    if (this.entries.has(key)) {
      // Refresh recency: re-insert so it isn't the next eviction victim.
      const existing = this.entries.get(key)!;
      this.entries.delete(key);
      this.entries.set(key, existing);
      return key;
    }
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { key, content, bytes: Buffer.byteLength(content, 'utf8') });
    return key;
  }

  get(key: string): ICcrEntry | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  size(): number {
    return this.entries.size;
  }
}
