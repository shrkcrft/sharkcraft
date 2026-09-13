import type { ProbedIdSource } from './probed-id-source.ts';
import type { IdReferenceKind } from './reference-registry.ts';

/**
 * One id-list field of an asset and the registry its ids resolve in — a row of
 * THE binding table (`PROBED_ID_FIELDS`).
 */
export interface IProbedIdField {
  /** The asset kind declaring the field. */
  readonly source: ProbedIdSource;
  /** Dotted path of the field on the asset (`discovery.profileIds`, `metadata.requiredConventionIds`). */
  readonly field: string;
  /** The reference kind its ids resolve against — through THE resolver, never a private lookup. */
  readonly kind: IdReferenceKind;
  /** Noun in the finding code (`<source>-<label>-missing`) and messages. */
  readonly label: string;
}
