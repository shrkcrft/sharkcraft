import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { AppErrorImpl, ERROR_CODES, type AppError } from '@shrkcrft/core';
import type { IEdge } from '../schema/edge.ts';
import type { IFileFingerprint } from '../schema/file-fingerprint.ts';
import type { IGraphManifest } from '../schema/manifest.ts';
import type { INode } from '../schema/node.ts';
import { GRAPH_SCHEMA } from '../schema/schema-version.ts';
import type { IGraphSnapshot } from '../schema/graph-snapshot.ts';

const NODES_DIR = 'nodes';
const EDGES_DIR = 'edges';
const META_FILE = 'meta.json';
const FILES_FILE = 'files.json';

/**
 * On-disk JSONL graph store under `<root>/.sharkcraft/graph/`.
 *
 * Layout (MVP):
 *   meta.json            manifest, schema version
 *   files.json           { path: IFileFingerprint }
 *   nodes/<kind>.jsonl   one row per node, sorted by id
 *   edges/<kind>.jsonl   one row per edge, sorted by id
 *
 * The store is the only writer; callers go through `writeSnapshot` for a
 * full rewrite or `appendNodes` / `appendEdges` for surgical updates (R64).
 *
 * `loadSnapshot` reads everything into memory. For SharkCraft-sized
 * repos that's a few MB at most; SQLite swap is not on the MVP path
 * (see code-intelligence.md §6.3 upgrade triggers).
 */
export class GraphStore {
  public readonly storeDir: string;

  constructor(private readonly projectRoot: string) {
    this.storeDir = nodePath.join(projectRoot, '.sharkcraft', 'graph');
  }

  exists(): boolean {
    return existsSync(nodePath.join(this.storeDir, META_FILE));
  }

  clear(): void {
    if (existsSync(this.storeDir)) {
      rmSync(this.storeDir, { recursive: true, force: true });
    }
  }

  /**
   * Write a full snapshot. Overwrites any existing store. Manifest digest
   * is computed from the resulting JSONL files.
   */
  writeSnapshot(
    nodes: readonly INode[],
    edges: readonly IEdge[],
    files: readonly IFileFingerprint[],
    partial: Omit<IGraphManifest, 'schema' | 'digest'>,
  ): IGraphManifest {
    // Clear stale per-kind JSONL files so kinds that became empty
    // (e.g. PackageDependsOn after a delete) don't survive across
    // writes. This is the simplest correctness guarantee — the store
    // is small enough that the cost is negligible.
    const nodesDir = nodePath.join(this.storeDir, NODES_DIR);
    const edgesDir = nodePath.join(this.storeDir, EDGES_DIR);
    if (existsSync(nodesDir)) rmSync(nodesDir, { recursive: true, force: true });
    if (existsSync(edgesDir)) rmSync(edgesDir, { recursive: true, force: true });
    mkdirSync(nodesDir, { recursive: true });
    mkdirSync(edgesDir, { recursive: true });

    const uniqueNodes = dedupeById(nodes);
    const uniqueEdges = dedupeById(edges);
    const nodesByKind = bucketBy(uniqueNodes, (n) => n.kind);
    const edgesByKind = bucketBy(uniqueEdges, (e) => e.kind);

    const nodeCounts: Record<string, number> = {};
    const edgeCounts: Record<string, number> = {};

    for (const [kind, list] of Object.entries(nodesByKind)) {
      list.sort((a, b) => a.id.localeCompare(b.id));
      writeJsonl(nodePath.join(this.storeDir, NODES_DIR, `${kind}.jsonl`), list);
      nodeCounts[kind] = list.length;
    }
    for (const [kind, list] of Object.entries(edgesByKind)) {
      list.sort((a, b) => a.id.localeCompare(b.id));
      writeJsonl(nodePath.join(this.storeDir, EDGES_DIR, `${kind}.jsonl`), list);
      edgeCounts[kind] = list.length;
    }
    writeJson(
      nodePath.join(this.storeDir, FILES_FILE),
      Object.fromEntries([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f])),
    );

    const digest = computeStoreDigest(this.storeDir);
    const manifest: IGraphManifest = {
      schema: GRAPH_SCHEMA,
      digest,
      ...partial,
      nodesByKind: nodeCounts,
      edgesByKind: edgeCounts,
    };
    writeJson(nodePath.join(this.storeDir, META_FILE), manifest);
    return manifest;
  }

  /**
   * Load the full store into memory. Throws if the store is missing or
   * malformed — callers should check `exists()` first or wrap in a try.
   */
  loadSnapshot(): IGraphSnapshot {
    if (!this.exists()) {
      throw new Error(
        `code-graph store not found under ${this.storeDir}. Run 'shrk graph index' to build it.`,
      );
    }
    const manifest = readJson<IGraphManifest>(nodePath.join(this.storeDir, META_FILE));
    if (manifest.schema !== GRAPH_SCHEMA) {
      throw new Error(
        `code-graph schema mismatch: store=${manifest.schema}, expected=${GRAPH_SCHEMA}. Rebuild with 'shrk graph index'.`,
      );
    }
    const filesRaw = readJson<Record<string, IFileFingerprint>>(
      nodePath.join(this.storeDir, FILES_FILE),
    );
    const files = new Map<string, IFileFingerprint>(Object.entries(filesRaw));

    const nodes = new Map<string, INode>();
    const nodesDir = nodePath.join(this.storeDir, NODES_DIR);
    if (existsSync(nodesDir)) {
      for (const fname of readdirSync(nodesDir)) {
        if (!fname.endsWith('.jsonl')) continue;
        for (const row of readJsonl<INode>(nodePath.join(nodesDir, fname))) {
          nodes.set(row.id, row);
        }
      }
    }
    const edges = new Map<string, IEdge>();
    const edgesDir = nodePath.join(this.storeDir, EDGES_DIR);
    if (existsSync(edgesDir)) {
      for (const fname of readdirSync(edgesDir)) {
        if (!fname.endsWith('.jsonl')) continue;
        for (const row of readJsonl<IEdge>(nodePath.join(edgesDir, fname))) {
          edges.set(row.id, row);
        }
      }
    }
    return { manifest, nodes, edges, files };
  }

  /**
   * Recompute the digest from disk and verify it matches the manifest.
   * Used by `shrk graph status` and as a sanity check before queries.
   */
  verifyDigest(): { ok: boolean; expected: string; actual: string } {
    if (!this.exists()) return { ok: false, expected: '', actual: '' };
    const manifest = readJson<IGraphManifest>(nodePath.join(this.storeDir, META_FILE));
    const actual = computeStoreDigest(this.storeDir);
    return { ok: actual === manifest.digest, expected: manifest.digest, actual };
  }
}

function bucketBy<T>(list: readonly T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of list) {
    const k = key(item);
    if (!out[k]) out[k] = [];
    out[k]!.push(item);
  }
  return out;
}

function dedupeById<T extends { id: string }>(list: readonly T[]): readonly T[] {
  const byId = new Map<string, T>();
  for (const item of list) byId.set(item.id, item);
  return [...byId.values()];
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, body.length > 0 ? body + '\n' : '');
}

function readJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, 'utf8');
  if (!raw) return [];
  const out: T[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    // A single malformed line (truncated write, hand-edit, partial fsync)
    // must NOT crash the whole CLI with a raw `Fatal: JSON Parse error` — it
    // surfaces as a typed corrupt-store error citing the file + 1-based line so
    // the caller can print a deterministic "rebuild the index" hint instead.
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch (cause) {
      throw corruptStoreError(path, cause, i + 1);
    }
  }
  return out;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson<T>(path: string): T {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw corruptStoreError(path, cause);
  }
}

/**
 * `details.kind` marker on the AppError thrown when a store file fails to
 * parse, so callers distinguish "store is corrupt, rebuild it" from any other
 * IO error WITHOUT brittle message-matching. Module-private — callers use
 * {@link isGraphStoreCorruptError}.
 */
const GRAPH_STORE_CORRUPT_KIND = 'graph-store-corrupt';

/**
 * True when `err` is the typed corrupt-store error thrown by the JSONL/JSON
 * loaders. Duck-typed (not `instanceof`) so it stays reliable even if two
 * copies of `@shrkcrft/core`'s AppErrorImpl class exist across package
 * boundaries — the `details.kind` marker is the contract.
 */
export function isGraphStoreCorruptError(err: unknown): err is AppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { details?: Record<string, unknown> }).details?.['kind'] === GRAPH_STORE_CORRUPT_KIND
  );
}

/** Build the typed corrupt-store AppError, carrying the file (+ 1-based line). */
function corruptStoreError(file: string, cause: unknown, line?: number): AppError {
  const at = line !== undefined ? `${file} (line ${line})` : file;
  return new AppErrorImpl(
    ERROR_CODES.IO_ERROR,
    `code-graph store is corrupt — failed to parse ${at}. Run 'shrk graph index' to rebuild it.`,
    {
      cause,
      details: { kind: GRAPH_STORE_CORRUPT_KIND, file, ...(line !== undefined ? { line } : {}) },
      suggestion: "Run 'shrk graph index' to rebuild the code-graph store.",
    },
  );
}

/**
 * SHA-256 over the concatenation of all JSONL files (alphabetical) plus
 * files.json. meta.json itself is excluded — it holds the digest.
 */
function computeStoreDigest(storeDir: string): string {
  const hash = createHash('sha256');
  const targets: string[] = [];
  const filesJson = nodePath.join(storeDir, FILES_FILE);
  if (existsSync(filesJson)) targets.push(filesJson);
  for (const sub of [NODES_DIR, EDGES_DIR]) {
    const dir = nodePath.join(storeDir, sub);
    if (!existsSync(dir)) continue;
    for (const fname of readdirSync(dir).sort()) {
      if (!fname.endsWith('.jsonl')) continue;
      targets.push(nodePath.join(dir, fname));
    }
  }
  targets.sort();
  for (const t of targets) {
    hash.update(nodePath.relative(storeDir, t));
    hash.update('\0');
    hash.update(readFileSync(t));
    hash.update('\0');
  }
  return hash.digest('hex');
}
