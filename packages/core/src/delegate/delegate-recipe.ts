/**
 * The `IDelegateRecipe` contract — a fenced, mechanical task a local-LLM worker
 * may produce edits for (see `shrk delegate`).
 *
 * Lives in `core` (not `config`) so BOTH the config loader AND the pack contract
 * (`@shrkcrft/plugin-api`, which depends only on core) can reference it — a pack
 * ships recipes via `delegateRecipeFiles`, the config declares them inline, and
 * both resolve to this one type.
 */

/**
 * Routing hints for a delegate recipe (forward-compat; recipes are resolved by
 * explicit `--recipe <id>` today). Kept primitive — no dependency on the
 * higher-layer task router.
 */
export interface IDelegateRecipeMatch {
  keywords?: readonly string[];
  fileGlobs?: readonly string[];
}

/** A fenced, mechanical task a local-LLM worker may produce edits for. */
export interface IDelegateRecipe {
  /** Stable id used by `shrk delegate run --recipe <id>`. */
  id: string;
  /** Human-readable label. */
  title?: string;
  /** Optional routing hints (unused by the explicit-`--recipe` path). */
  match?: IDelegateRecipeMatch;
  /**
   * Allow-list of globs the worker may touch. A target path matching NONE of
   * these is refused before any write — the worker's blast radius is fenced.
   */
  guardrailGlobs: readonly string[];
  /**
   * `IPlannedOperation` kinds the worker may emit (e.g. `'export'`,
   * `'ensure-import'`). An op of any other kind is dropped, never applied.
   */
  allowedOps: readonly string[];
  /** Local provider preference; defaults to the delegation block / `'auto'`. */
  provider?: 'auto' | 'ollama' | 'llamacpp';
  /** Model id passed to the provider. */
  model?: string;
  /** Max generate→verify attempts before escalating to a human. Default 2. */
  maxAttempts?: number;
  /** Per-attempt wall-clock budget (ms) for the model call. */
  maxBudgetMs?: number;
  /** Refuse delegation when the task risk exceeds this ceiling. */
  riskCeiling?: 'low' | 'medium';
  /**
   * Deterministic verification ids run after the edit lands. Each MUST resolve
   * to a `verificationCommands[].id` — this is the only way a recipe runs a
   * verify command (a pack can never inject executable shell).
   */
  verificationIds: readonly string[];
}
