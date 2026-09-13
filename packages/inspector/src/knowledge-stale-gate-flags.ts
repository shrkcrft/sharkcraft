import type { IVerdictCoverage } from '@shrkcrft/core';

/**
 * What a caller of the knowledge stale-check gate asked for EXPLICITLY — the
 * flags of `shrk knowledge stale-check` / `verify`. `shrk quality`, `shrk
 * release readiness` and every `buildQualityReport` consumer (MCP, the
 * dashboard, the report site) pass `{}`: they run on the config alone.
 *
 * `knowledgeStaleGateInput` folds these over the config's `knowledgeCheck`
 * block — the ONE place that precedence is decided (a flag wins) — so the verb,
 * the quality gate and readiness cannot read the config three ways.
 */
export interface IKnowledgeStaleGateFlags {
  /** `--ci`. */
  readonly ci?: boolean;
  /** The verb's own `--strict` (required references only, like `--ci`). */
  readonly strict?: boolean;
  /** Validated `--fail-on` categories. Absent / empty = not given: `knowledgeCheck.failOn` applies. */
  readonly failOn?: readonly string[];
  /** `--min-referenced` — wins over `knowledgeCheck.minReferenced`. */
  readonly minReferenced?: { readonly ratio: number; readonly acceptedBy: string };
  /** `--require-references` (ORed with `knowledgeCheck.requireReferences`). */
  readonly requireReferences?: boolean;
  /** `allowEmptyValve(args, entriesInScope)`. Never set from config. */
  readonly emptyAcceptance?: Pick<IVerdictCoverage, 'acceptedBy'>;
  /** `--stale-after`, in days — the window the `aged` category measures against. */
  readonly staleAfterDays?: number;
  /** `--as-of` (only meaningful with a `--stale-after` window). */
  readonly asOf?: string;
}
