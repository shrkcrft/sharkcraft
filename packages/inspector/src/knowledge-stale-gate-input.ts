import type { IVerdictCoverage } from '@shrkcrft/core';
import type { IInspectionDiscovery } from './inspection-discovery.ts';

/**
 * What the knowledge stale-check verdict is decided FROM, besides the report —
 * the flags of `shrk knowledge stale-check`, or the config `knowledgeCheck`
 * block when `shrk quality` / `buildQualityReport` runs the same gate.
 */
export interface IKnowledgeStaleGateInput {
  /** `--ci`: required references that fail are blocking. */
  readonly ci: boolean;
  /** The verb's own `--strict` (required references, like `--ci`). */
  readonly strict: boolean;
  /** Validated `--fail-on` categories (see `KNOWLEDGE_FAIL_ON_CATEGORIES`). */
  readonly failOn: ReadonlySet<string>;
  /**
   * `--min-referenced <ratio>` (or `knowledgeCheck.minReferenced`): the least
   * share of in-scope entries the check must examine. Below it the run FAILS;
   * at or above it the remaining unverifiable entries are ACCEPTED, and the
   * acceptance is printed with `acceptedBy` verbatim.
   */
  readonly minReferenced?: { readonly ratio: number; readonly acceptedBy: string };
  /** `--require-references` / `--fail-on unverifiable` / `knowledgeCheck.requireReferences`. */
  readonly requireReferences: boolean;
  /**
   * The `--allow-empty` valve (`allowEmptyValve(args, entriesInScope)`), or `{}`.
   * Honoured ONLY for a legitimately empty scope — never over a missing
   * `sharkcraft/` folder or a config that failed to load.
   */
  readonly emptyAcceptance: Pick<IVerdictCoverage, 'acceptedBy'>;
  /** The run was narrowed to a changeset (`--changed-only` / `--since` / `--staged` / `--files`). */
  readonly scoped: boolean;
  /** Where discovery landed — the refusal names it when nothing was loaded. */
  readonly discovery: IInspectionDiscovery;
  /**
   * Set when the request can never be evaluated as asked — a category that
   * cannot fire (`aged` with no `--stale-after` window, from a flag or from
   * `knowledgeCheck.failOn`), or `--as-of` with no window to date. The verb
   * exits `3`; `shrk quality` reports the item `error`; readiness is not ready.
   * Never a verdict.
   */
  readonly usageProblem?: string;
}
