import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  utimesSync,
  rmSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { Buffer } from 'node:buffer';
import type { ICcrStore } from './ccr-store.ts';
import type { ICcrEntry } from './ccr-entry.ts';
import { ccrKey } from './ccr-key.ts';

/** CCR keys are content hashes — hex only. Rejects path-traversal lookups. */
const VALID_KEY = /^[0-9a-f]{1,64}$/;

export interface ITtlFileCcrStoreOptions {
  /** Entry lifetime in ms. 0 (default) = no expiry. */
  ttlMs?: number;
  /** Max live entries; oldest are evicted past this. 0 (default) = unbounded. */
  maxEntries?: number;
  /** Refresh an entry's timestamp on read (sliding TTL + LRU). Default false. */
  refreshOnAccess?: boolean;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Filesystem-backed CCR store with TTL + size eviction, for the CLI write path
 * (P5.1). Like {@link FileCcrStore} each original is a content-addressed file
 * (cross-process by construction), but the file's mtime is the entry timestamp:
 * entries older than `ttlMs` are treated as absent (and lazily removed), and a
 * `put` past `maxEntries` evicts the oldest. The MCP server never uses this —
 * it stays in-memory to honour the read-only contract.
 *
 * Stateful by design (a cache, not the deterministic engine path); the clock is
 * injectable so tests are reproducible.
 */
export class TtlFileCcrStore implements ICcrStore {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly refreshOnAccess: boolean;
  private readonly now: () => number;

  constructor(dir: string, opts: ITtlFileCcrStoreOptions = {}) {
    // Field init only.
    this.dir = dir;
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 0;
    this.maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : 0;
    this.refreshOnAccess = opts.refreshOnAccess ?? false;
    this.now = opts.now ?? ((): number => Date.now());
  }

  private pathFor(key: string): string {
    return nodePath.join(this.dir, `${key}.txt`);
  }

  private stamp(file: string, ms: number): void {
    const d = new Date(ms);
    utimesSync(file, d, d);
  }

  private isExpired(mtimeMs: number): boolean {
    return this.ttlMs > 0 && this.now() - mtimeMs > this.ttlMs;
  }

  private remove(file: string): void {
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort eviction
    }
  }

  put(content: string): string {
    const key = ccrKey(content);
    const file = this.pathFor(key);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, content, 'utf8');
    this.stamp(file, this.now());
    this.evict();
    return key;
  }

  get(key: string): ICcrEntry | undefined {
    if (!VALID_KEY.test(key)) return undefined;
    const file = this.pathFor(key);
    if (!existsSync(file)) return undefined;
    if (this.isExpired(statSync(file).mtimeMs)) {
      this.remove(file);
      return undefined;
    }
    if (this.refreshOnAccess) this.stamp(file, this.now());
    const content = readFileSync(file, 'utf8');
    return { key, content, bytes: Buffer.byteLength(content, 'utf8') };
  }

  has(key: string): boolean {
    if (!VALID_KEY.test(key)) return false;
    const file = this.pathFor(key);
    if (!existsSync(file)) return false;
    if (this.isExpired(statSync(file).mtimeMs)) {
      this.remove(file);
      return false;
    }
    return true;
  }

  size(): number {
    return this.liveEntries().length;
  }

  /** Live (non-expired) entries, sweeping expired files as a side effect. */
  private liveEntries(): Array<{ file: string; mtimeMs: number }> {
    if (!existsSync(this.dir)) return [];
    const out: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.txt')) continue;
      const file = nodePath.join(this.dir, name);
      const mtimeMs = statSync(file).mtimeMs;
      if (this.isExpired(mtimeMs)) {
        this.remove(file);
        continue;
      }
      out.push({ file, mtimeMs });
    }
    return out;
  }

  private evict(): void {
    if (this.maxEntries <= 0) return;
    const live = this.liveEntries();
    if (live.length <= this.maxEntries) return;
    live.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const e of live.slice(0, live.length - this.maxEntries)) this.remove(e.file);
  }
}
