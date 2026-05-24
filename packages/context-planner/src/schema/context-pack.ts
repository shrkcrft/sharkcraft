/**
 * Compact, deterministic context pack consumable by AI coding agents.
 *
 * Output of `@shrkcrft/context-planner`. Stable JSON shape so an agent
 * can persist node ids across turns and verify what was cut.
 *
 * Schema: sharkcraft.context-pack/v1.
 */
export const CONTEXT_PACK_SCHEMA = 'sharkcraft.context-pack/v1' as const;

export type TaskIntent =
  | 'feature'
  | 'bug-fix'
  | 'refactor'
  | 'docs'
  | 'release'
  | 'migration'
  | 'unknown';

export interface IRankedFile {
  /** Project-relative POSIX path. */
  path: string;
  /** Code-graph node id (`file:<path>`). */
  nodeId: string;
  /** Score in [0, 1]. Higher = more relevant. */
  score: number;
  /** Estimated token cost (approximate; deterministic). */
  estimatedTokens: number;
  /** Free-form reasons the file ranked. */
  reasons: readonly string[];
}

export interface IRuleHit {
  id: string;
  label: string;
  severity?: string;
}

export interface IPathHit {
  id: string;
  label: string;
}

export interface ITemplateHit {
  id: string;
  label: string;
}

export interface IRiskHit {
  /** Risk category, e.g. 'cycle', 'public-api', 'cross-package'. */
  kind: string;
  /** Display label. */
  label: string;
  /** Related node ids (optional). */
  refs?: readonly string[];
}

export interface IContextPack {
  schema: typeof CONTEXT_PACK_SCHEMA;
  intent: TaskIntent;
  /** Free-text task as provided by the caller. */
  task: string;
  /** Ranked relevant files (after token-budget pruning). */
  files: readonly IRankedFile[];
  /** Rule-graph hits over the selected file set. */
  rules: readonly IRuleHit[];
  paths: readonly IPathHit[];
  templates: readonly ITemplateHit[];
  /** Likely tests for the file set. */
  tests: readonly string[];
  /** Surfaced risks: cycles, public-API touches, etc. */
  risks: readonly IRiskHit[];
  /**
   * Files the agent should NOT modify in this pack — generated files,
   * vendored code, lock files, dist/build outputs.
   */
  doNotTouch: readonly string[];
  /** Token budget summary. */
  budget: {
    requested: number;
    used: number;
    /** True when the selection was capped by budget. */
    truncated: boolean;
  };
  /** Free-form diagnostics. */
  diagnostics: readonly string[];
}
