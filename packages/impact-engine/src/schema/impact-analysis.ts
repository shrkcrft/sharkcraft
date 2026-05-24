/**
 * v3 impact-analysis payload. Built from the persistent code graph and
 * (when available) the rule-graph bridge. Intentionally compatible with
 * the existing v2 payload's *core shape* (input kind, normalised
 * targets, dependent files, packages, tests) while adding:
 *
 *   - affectedSymbols / affectedCallerFiles — Wave 3 symbol edges.
 *   - affectedRules / affectedTemplates / affectedPaths — rule-graph bridge.
 *   - publicApiTouched — true if any normalised target is an index
 *     entrypoint or declares an exported symbol.
 *   - validationScope — exact `shrk …` commands to run.
 */
export const GRAPH_IMPACT_SCHEMA = 'sharkcraft.graph-impact-analysis/v3' as const;

export type GraphImpactSchemaVersion = typeof GRAPH_IMPACT_SCHEMA;

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface IAffectedNodeRef {
  /** Stable graph node id, e.g. `file:packages/foo/src/bar.ts`. */
  id: string;
  /** Project-relative path for File / Symbol nodes. */
  path?: string;
  /** Display label (symbol name, file basename, …). */
  label: string;
  /** Kind tag, e.g. 'file' | 'symbol' | 'package'. */
  kind: string;
  /** 1-based line number for symbols. */
  line?: number;
}

export interface IAffectedAssetRef {
  /** Bridge node id, e.g. `boundary:core.is-base-layer`. */
  id: string;
  /** Display label. */
  label: string;
  /** Optional severity / data carried over from the bridge edge. */
  severity?: string;
}

export interface IGraphImpactAnalysis {
  schema: GraphImpactSchemaVersion;
  /** What kind of input the report was built from. */
  inputKind: 'files' | 'symbol' | 'gitref';
  /** Original normalised targets (file paths or `symbol:` ids). */
  normalizedTargets: readonly string[];
  /** Files importing a target directly (1-hop). */
  directDependents: readonly IAffectedNodeRef[];
  /** Files reachable via repeated reverse-import walk (capped). */
  transitiveDependents: readonly IAffectedNodeRef[];
  /** Symbols *declared by* the targets. */
  affectedSymbols: readonly IAffectedNodeRef[];
  /** Files that call/reference any affected symbol. */
  affectedCallerFiles: readonly IAffectedNodeRef[];
  /** Workspace packages touched (union of target packages + dependents). */
  affectedPackages: readonly string[];
  /** Rules (boundary) that apply to a target or dependent file. */
  affectedRules: readonly IAffectedAssetRef[];
  /** Path conventions matching a target or dependent file. */
  affectedPaths: readonly IAffectedAssetRef[];
  /** Templates whose output covers a target or dependent file. */
  affectedTemplates: readonly IAffectedAssetRef[];
  /** Likely tests for the targets / dependents (tag=test + dependent). */
  likelyTests: readonly IAffectedNodeRef[];
  /** True if any normalised target is an `index.ts` or declares exports. */
  publicApiTouched: boolean;
  /** Risk classification. */
  risk: RiskLevel;
  /** Human-readable reasons that contributed to the risk score. */
  riskReasons: readonly string[];
  /** Exact CLI commands to run before / after merging the change. */
  validationScope: readonly string[];
  /** Capped-list counters (when lists were truncated). */
  truncations: Readonly<Record<string, number>>;
  /** Free-form diagnostics (missing index, stale graph, etc.). */
  diagnostics: readonly string[];
}
