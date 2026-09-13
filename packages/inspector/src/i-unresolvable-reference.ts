import type { ReferenceKind } from './reference-registry.ts';
import type { UnresolvableReason } from './unresolvable-reason.ts';

/**
 * One declared reference the self-config doctor's reference probes could not
 * check — its kind's registry is empty here, or can never be filled — with the
 * file and field that declare it (round 12, ONE-CHANGE). The doctor's coverage
 * counts each as an unexamined unit; the contributions report groups them by
 * file. Both read the same probes, so they cannot disagree.
 */
export interface IUnresolvableReference {
  /** Absolute path of the declaring file, when the asset records one. */
  readonly file?: string;
  /** Owning pack, when the asset is a pack contribution. */
  readonly packageName?: string;
  /** The declaring asset's kind (`registration-hint`, `convention`, `template`, …). */
  readonly sourceKind: string;
  readonly sourceId: string;
  /** The declaring field (`discovery.profileIds`, `recommends.templates`, `related`, …). */
  readonly field: string;
  /**
   * The kind the id resolves against — `any` for a declared field that accepts
   * every kind; `search-document` for a search-tuning boost key whose document
   * kind has no id registry at all (`doc:`, `preset:`, …; round 13).
   */
  readonly kind: ReferenceKind | 'any' | 'search-document';
  readonly id: string;
  readonly reason: UnresolvableReason;
}
