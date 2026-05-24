import type { IEdge } from './edge.ts';
import type { IFileFingerprint } from './file-fingerprint.ts';
import type { IGraphManifest } from './manifest.ts';
import type { INode } from './node.ts';

/**
 * In-memory snapshot of the graph — the unit the query API operates on.
 *
 * `nodes` and `edges` are flat maps keyed by id. The store loads JSONL
 * into this shape; the indexer builds it before writing. Callers should
 * treat it as immutable after construction.
 */
export interface IGraphSnapshot {
  manifest: IGraphManifest;
  nodes: ReadonlyMap<string, INode>;
  edges: ReadonlyMap<string, IEdge>;
  files: ReadonlyMap<string, IFileFingerprint>;
}
