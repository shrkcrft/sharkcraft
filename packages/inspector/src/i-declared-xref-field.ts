import type { ReferenceKind } from './reference-registry.ts';

/**
 * One asset field that carries cross-reference ids — a row of
 * `DECLARED_XREF_FIELDS`, the ONE table of which declared fields hold ids.
 */
export interface IDeclaredXrefField {
  /** The asset kind that declares the field (itself a reference kind). */
  readonly sourceKind: ReferenceKind;
  /**
   * Dotted path of the field on the asset (`actionHints.relatedKnowledge`).
   * `facets` stands for every construct facet value that declares `resolvesAs`.
   */
  readonly field: string;
  /**
   * The kinds an id in this field may resolve as. `'any'` = every kind (the
   * untyped `related` / `seeAlso`); `'declared'` = per value, from the value's
   * own `resolvesAs` (construct facets).
   */
  readonly accepts: readonly ReferenceKind[] | 'any' | 'declared';
  /** Severity of a dangling or wrong-kind id in this field. */
  readonly severity: 'error' | 'warning';
  /** Graph relation the field expresses: `supersedes` for `supersededBy`, else `related`. */
  readonly relation: 'related' | 'supersedes';
}
