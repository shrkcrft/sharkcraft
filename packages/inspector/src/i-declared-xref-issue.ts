import type { ReferenceKind } from './reference-registry.ts';

/**
 * A problem with a declaration itself rather than with one id's resolution:
 * a facet naming a reference kind that does not exist (the `$use`-typo shape),
 * a supersession cycle or chain, a field that is not a list of string ids.
 */
export interface IDeclaredXrefIssue {
  readonly code:
    | 'xref-unknown-kind'
    | 'xref-superseded-cycle'
    | 'xref-superseded-chain'
    | 'xref-malformed';
  readonly severity: 'error' | 'warning';
  readonly sourceKind: ReferenceKind;
  readonly sourceId: string;
  readonly field: string;
  /**
   * The id the issue concerns: the successor of a supersession issue; for
   * `xref-unknown-kind`, the facet VALUE whose declared kind is typo'd — that
   * value may well resolve, the KIND is what is wrong.
   */
  readonly targetId?: string;
  /** A facet value's `id` (`facets.<name>` issues): which value of the facet the issue is about. */
  readonly facetId?: string;
  readonly file?: string;
  readonly packageName?: string;
  readonly message: string;
}
