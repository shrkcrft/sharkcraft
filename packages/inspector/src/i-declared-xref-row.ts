import type { DeclaredXrefStatus } from './declared-xref-status.ts';
import type { ReferenceKind } from './reference-registry.ts';

/** One declared cross-reference id, resolved against the reference registry. */
export interface IDeclaredXrefRow {
  /** The asset kind that declares the id. */
  readonly sourceKind: ReferenceKind;
  readonly sourceId: string;
  /** The field it sits in (`related`, `actionHints.relatedTemplates`, `facets.<name>`). */
  readonly field: string;
  /** For a facet value: the value's own id within the facet. */
  readonly facetId?: string;
  readonly targetId: string;
  /** Where the source asset is declared (project-relative when possible). */
  readonly file?: string;
  /** Set when the source asset is pack-contributed. */
  readonly packageName?: string;
  /** The kinds the field accepts (`'any'` = every kind). */
  readonly accepts: readonly ReferenceKind[] | 'any';
  /** EVERY kind whose registry lists the id, most specific first. Empty = resolves nowhere. */
  readonly resolvedAs: readonly ReferenceKind[];
  readonly status: DeclaredXrefStatus;
  /** The field's severity for a dangling / wrong-kind id; `info` for ok and unverified. */
  readonly severity: 'error' | 'warning' | 'info';
  readonly relation: 'related' | 'supersedes';
  readonly message: string;
  /** Closest registered ids among the accepted kinds (dangling / wrong-kind only). */
  readonly didYouMean: readonly string[];
}
