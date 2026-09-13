import type { IConventionApplicabilityReason } from './i-convention-applicability-reason.ts';

/**
 * Which of a file list one convention covers — `conventionScope`, the ONE
 * answer `conventions check` and the rule-graph bridge both read (round 15).
 */
export interface IConventionScope {
  readonly conventionId: string;
  /**
   * False when a workspace filter excluded the convention, or when the file
   * list was non-empty and no file in it passed the per-file filters: the
   * convention is then never evaluated, and {@link reasons} say why.
   */
  readonly applicable: boolean;
  /** The files of the list the convention covers, in list order (empty when not applicable). */
  readonly files: readonly string[];
  /** The declared filters, judged — over the whole list for the per-file ones. */
  readonly reasons: readonly IConventionApplicabilityReason[];
}
