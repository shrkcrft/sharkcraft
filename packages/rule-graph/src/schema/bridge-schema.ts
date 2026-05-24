import type { IEdge, INode } from '@shrkcrft/graph';

export const RULE_GRAPH_SCHEMA = 'sharkcraft.rule-graph/v1' as const;

export type RuleGraphSchemaVersion = typeof RULE_GRAPH_SCHEMA;

export interface IBridgeManifest {
  schema: RuleGraphSchemaVersion;
  projectRoot: string;
  lastBuiltAt: string;
  lastBuildDurationMs: number;
  /** SHA-256 of the bridge store's JSONL files. */
  digest: string;
  /** Per-kind counters at build time. */
  nodesByKind: Readonly<Record<string, number>>;
  edgesByKind: Readonly<Record<string, number>>;
  /** Counters by bridge source (rule / path / template). */
  sourceCounts: Readonly<Record<string, number>>;
  /**
   * Coverage of the file set by `applies-rule` edges (boundaries +
   * knowledge rules). Templates and path conventions are NOT counted —
   * the roadmap (§3.2) defines coverage gap specifically as "files with
   * no applicable rule". Optional for forward-compat with manifests
   * written before the field existed.
   */
  filesTotal?: number;
  filesCoveredByRules?: number;
  filesUncoveredByRules?: number;
}

export interface IBridgeSnapshot {
  manifest: IBridgeManifest;
  nodes: ReadonlyMap<string, INode>;
  edges: ReadonlyMap<string, IEdge>;
}
