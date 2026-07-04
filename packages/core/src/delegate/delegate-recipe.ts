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

/**
 * A delegate recipe's mode. `patch` recipes produce a fenced, deterministically-
 * verified edit (the original delegate path). `analysis` recipes are READ-ONLY:
 * a local model adds judgment on top of a deterministic report the engine
 * computes first (`groundedOn`), and never writes. The two modes are disjoint —
 * an `analysis` recipe carries no write-fence (`guardrailGlobs`/`allowedOps`/
 * `verificationIds`); a `patch` recipe carries no `groundedOn`.
 */
export type DelegateRecipeMode = 'patch' | 'analysis';

/**
 * Deterministic reports an `analysis` recipe may ground on. The engine runs the
 * named report FIRST and feeds it as ground truth; the model's claims are then
 * cross-checked against it (a claim referencing an entity absent from the report
 * is flagged `unverified`). Adding a new grounding source is a two-step change:
 * add its id here and wire its runner in the inspector's grounding dispatch.
 */
export const DELEGATE_GROUNDING_IDS = ['task-risk', 'delegate-failure', 'test-impact', 'plan-simulation', 'agent-brief'] as const;
export type DelegateGroundingId = (typeof DELEGATE_GROUNDING_IDS)[number];

/**
 * Read-only engine queries an `analysis` recipe may let the model pull mid-run
 * (the bounded query loop, Phase 3). Each maps to a deterministic, read-only
 * inspector function — there is deliberately NO write/apply/gen/sign query. The
 * model requests them by id; anything not in the recipe's `allowedQueries` is
 * refused. Adding a query is a two-step change: add its id here and wire its
 * executor in the cli's read-only query dispatch.
 */
export const DELEGATE_QUERY_IDS = ['task-risk', 'coverage', 'test-impact', 'graph-callers', 'graph-context'] as const;
export type DelegateQueryId = (typeof DELEGATE_QUERY_IDS)[number];

/** A fenced, mechanical task a local-LLM worker may produce edits for. */
export interface IDelegateRecipe {
  /** Stable id used by `shrk delegate run --recipe <id>`. */
  id: string;
  /** Human-readable label. */
  title?: string;
  /** Optional routing hints (unused by the explicit-`--recipe` path). */
  match?: IDelegateRecipeMatch;
  /**
   * Recipe mode. Defaults to `'patch'` (back-compat — an unset mode is a patch
   * recipe). `'analysis'` recipes are read-only and grounded, never writing.
   */
  mode?: DelegateRecipeMode;
  /**
   * (`analysis` only) The deterministic report the engine runs first and the
   * model's judgment is grounded against. Must be one of `DELEGATE_GROUNDING_IDS`.
   */
  groundedOn?: DelegateGroundingId;
  /**
   * (`analysis` only, optional) The registered analysis response schema the
   * model must emit. Defaults to the built-in findings shape.
   */
  outputShape?: string;
  /**
   * (`analysis` only, optional) Read-only engine queries the model may pull
   * mid-run via the bounded query loop. Each must be a `DELEGATE_QUERY_IDS`
   * value. Empty / unset ⇒ single-shot analysis (no loop).
   */
  allowedQueries?: readonly DelegateQueryId[];
  /**
   * (`analysis` only, optional) Max query rounds before the model must answer.
   * Clamped to `[0, 4]`; `0` (default) disables the loop even if `allowedQueries`
   * is set. A round budget bounds wall-clock alongside `maxBudgetMs`.
   */
  maxQueryRounds?: number;
  /**
   * (`analysis` only, optional) Fan the analysis out into per-slice passes over
   * the grounding entities, then merge+dedup (Phase 4 — the "subagent-like"
   * output). Engine-owned, deterministic; use only when per-unit isolation helps.
   * No-op when the grounding has < 2 entities. Ignored alongside `allowedQueries`
   * (fan-out takes precedence; each slice is single-shot).
   */
  fanOut?: boolean;
  /** (`analysis` only, optional) Max fan-out slices. Clamped `[2, 6]`; default 3. */
  maxFanOut?: number;
  /**
   * (`analysis` only, optional) A PATCH recipe id this analysis may escalate to
   * (e.g. `test-gap-scan` → `scaffold-test-stub`). Surfaces an advisory
   * next-command in the report; `shrk delegate analyze --escalate` additionally
   * GENERATES (never applies) that patch's signed plan through the four fences.
   */
  escalateTo?: string;
  /**
   * (`patch` only) Allow-list of globs the worker may touch. A target path
   * matching NONE of these is refused before any write — the worker's blast
   * radius is fenced. Required for a `patch` recipe; absent for `analysis`.
   */
  guardrailGlobs?: readonly string[];
  /**
   * (`patch` only) `IPlannedOperation` kinds the worker may emit (e.g.
   * `'export'`, `'ensure-import'`). An op of any other kind is dropped, never
   * applied. Required for a `patch` recipe; absent for `analysis`.
   */
  allowedOps?: readonly string[];
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
   * (`patch` only) Deterministic verification ids run after the edit lands. Each
   * MUST resolve to a `verificationCommands[].id` — this is the only way a recipe
   * runs a verify command (a pack can never inject executable shell). Required
   * for a `patch` recipe; absent for `analysis` (which never writes).
   */
  verificationIds?: readonly string[];
}
