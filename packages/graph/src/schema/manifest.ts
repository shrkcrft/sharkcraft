import type { GraphSchemaVersion } from './schema-version.ts';

/**
 * `.sharkcraft/graph/meta.json` shape.
 *
 * `digest` is SHA-256 over the concatenated JSONL files (alphabetical),
 * computed at write time. A stale digest signals a tampered or partial
 * store and must trigger a rebuild rather than silent use.
 */
export interface IGraphManifest {
  schema: GraphSchemaVersion;
  projectRoot: string;
  lastIndexedAt: string;
  /** Wall-clock duration of the last full index, in ms. */
  lastIndexDurationMs: number;
  filesIndexed: number;
  nodesByKind: Readonly<Record<string, number>>;
  edgesByKind: Readonly<Record<string, number>>;
  /** SHA-256 of all JSONL files. */
  digest: string;
  /** Workspace packages discovered at index time. */
  workspacePackages: readonly string[];
  /**
   * Count of strongly-connected components of size ≥ 2 in the
   * `imports-file` subgraph, computed at index time. Optional for
   * forward-compat with manifests written before this field existed
   * (added 2026-05). Roadmap §3.1 promised cycle-aware queries; this
   * is the persisted counter the doctor + dashboard read from.
   */
  cycleCount?: number;
  /** Size of the largest SCC of size ≥ 2 (0 when no cycles). */
  largestCycleSize?: number;
  /** Total file nodes participating in any cycle. */
  filesInCycles?: number;
  /**
   * Number of `imports-file` edges that resolved to the
   * `unresolved:<spec>` sentinel (relative / alias / workspace path
   * the resolver could not match against an on-disk file). Optional
   * for forward-compat. The first ten distinct specifiers are kept
   * in `unresolvedImportSamples` for doctor + dashboard.
   */
  unresolvedImportCount?: number;
  /** Distinct files with at least one unresolved import. */
  filesWithUnresolvedImports?: number;
  /** First N distinct unresolved specifiers (sample for human/agent). */
  unresolvedImportSamples?: readonly string[];
}
