import type { ReferenceKind } from './reference-registry.ts';
import type { SearchTuningKeyStatus } from './search-tuning-key-status.ts';

/** The answer {@link resolveSearchTuningKey} gives for one boost key. */
export interface ISearchTuningKeyResolution {
  /** The boost key exactly as declared. */
  readonly key: string;
  readonly status: SearchTuningKeyStatus;
  /** The `<prefix>` when the key parsed as `<prefix>:<id>`. */
  readonly prefix?: string;
  /** The right-hand id — the WHOLE key when it has no prefix. */
  readonly id: string;
  /** The registry the id was (or would be) resolved in. */
  readonly referenceKind?: ReferenceKind;
  /**
   * The key to write instead: the prefixed form of an unprefixed key, the
   * nearest registered id of a missing one, or the nearest real prefix of an
   * unknown kind.
   */
  readonly suggestion?: string;
  /** Every prefixed form an unprefixed key resolves as (when more than one kind lists it). */
  readonly suggestions?: readonly string[];
  /** Why — always set for `unverified`, so the skip is never silent. */
  readonly reason?: string;
}
