import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import * as nodePath from 'node:path';

const CACHE_DIR = '.sharkcraft/smart-context/cache';
const CACHE_FILE = 'plans.jsonl';
const SCHEMA = 'sharkcraft.smart-context-plan-cache/v1';

export interface IPlanCachePlan {
  summary: string;
  taskUnderstanding: string;
  likelyTechnicalApproach: string;
  handoffSummary: string;
  // We do not type the full plan here to keep this module free of
  // smart-context internals — the cache stores it as `unknown`-typed
  // JSON and the smart-context command does the type narrowing.
  [key: string]: unknown;
}

export interface IPlanCacheEntry {
  schema: typeof SCHEMA;
  task: string;
  taskSlug: string;
  model: string;
  embeddingDimensions: number;
  /** base64-encoded little-endian Float32 vector. */
  embeddingB64: string;
  plan: IPlanCachePlan;
  /** Markdown rendering of the plan, kept for replay output. */
  planMarkdown?: string;
  savedAt: string;
}

export interface IPlanCacheHit {
  entry: IPlanCacheEntry;
  similarity: number;
}

/**
 * Append-only on-disk cache of past `--ai-plan` runs, keyed by the
 * task's embedding vector. Used by smart-context to short-circuit
 * (cache replay) or enrich (reference mode) future runs with similar
 * tasks.
 *
 * Storage: `.sharkcraft/smart-context/cache/plans.jsonl` — one JSON
 * line per entry. Append-only so concurrent writes from sibling shrk
 * invocations don't trample each other. The reader tolerates partial
 * / malformed lines (skips them).
 *
 * Embeddings are stored base64-encoded so the file stays
 * line-delimited; we trade a small parse cost for the ability to
 * grep / diff the file by hand.
 */
export class PlanCache {
  static append(cwd: string, entry: IPlanCacheEntry): string {
    const path = cacheFilePath(cwd);
    mkdirSync(nodePath.dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
    return path;
  }

  static all(cwd: string): IPlanCacheEntry[] {
    const path = cacheFilePath(cwd);
    if (!existsSync(path)) return [];
    let body: string;
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const out: IPlanCacheEntry[] = [];
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as IPlanCacheEntry;
        if (parsed.schema !== SCHEMA) continue;
        if (typeof parsed.embeddingB64 !== 'string') continue;
        out.push(parsed);
      } catch {
        // skip malformed line
      }
    }
    return out;
  }

  /**
   * Search the cache by cosine similarity. Both the query embedding
   * and the stored embeddings are expected to be unit-length (the
   * BGE pipeline normalises by default).
   */
  static findSimilar(
    cwd: string,
    queryEmbedding: Float32Array,
    options: { model: string; k?: number; minSimilarity?: number } = { model: '' },
  ): IPlanCacheHit[] {
    const entries = PlanCache.all(cwd);
    if (entries.length === 0) return [];
    const k = options.k ?? 5;
    const min = options.minSimilarity ?? 0;
    const hits: IPlanCacheHit[] = [];
    for (const entry of entries) {
      if (options.model && entry.model !== options.model) continue;
      if (entry.embeddingDimensions !== queryEmbedding.length) continue;
      const vec = decodeEmbedding(entry.embeddingB64, entry.embeddingDimensions);
      if (!vec) continue;
      let dot = 0;
      for (let i = 0; i < vec.length; i += 1) dot += vec[i]! * queryEmbedding[i]!;
      if (dot < min) continue;
      hits.push({ entry, similarity: dot });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, k);
  }

  /**
   * Replace the on-disk cache. Used by tests and any future
   * `plan-cache prune` subcommand.
   */
  static write(cwd: string, entries: readonly IPlanCacheEntry[]): string {
    const path = cacheFilePath(cwd);
    mkdirSync(nodePath.dirname(path), { recursive: true });
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8');
    return path;
  }
}

export function encodeEmbedding(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
}

function decodeEmbedding(b64: string, expectedDims: number): Float32Array | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (buf.byteLength !== expectedDims * 4) return null;
  const owned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(owned).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(owned);
}

function cacheFilePath(cwd: string): string {
  return nodePath.join(cwd, CACHE_DIR, CACHE_FILE);
}

export const PLAN_CACHE_SCHEMA = SCHEMA;
