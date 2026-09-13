import type { IUnitMark } from '@shrkcrft/core';
import type { ISearchTuningKeyResolution } from './search-tuning-key-resolution.ts';

/**
 * One search-tuning entry's declaration of one boost key (`boostIds` /
 * `taskHints[].boostIds`), resolved through THE key resolver — what
 * `searchTuningKeyProbes` returns. The lint settles and words these; the
 * self-config doctor's unresolvable-reference scan (and so `packs
 * contributions`) reads the SAME probes, so the two can never disagree about
 * whether a contributed boost key could be checked (round 13).
 */
export interface ISearchTuningKeyProbe {
  readonly tuningId: string;
  /** The boost key exactly as declared — the unit an expectEmpty marker names. */
  readonly key: string;
  /** Every id boost map of the entry that declares the key, in order (`boostIds`, `taskHints[<i>].boostIds`). */
  readonly lists: readonly string[];
  /** The entry's expectEmpty markers on the key — one per marked map, stamped with the contributing pack. */
  readonly marks: readonly IUnitMark[];
  /** THE key resolver's answer (one resolution per distinct key, shared by every entry declaring it). */
  readonly resolution: ISearchTuningKeyResolution;
  /** The entry's `appliesToKinds` — set when it excludes the key's document kind. */
  readonly appliesToKinds?: readonly string[];
  /** The document kind `appliesToKinds` excludes: the matcher skips the entry, so the boost never fires. */
  readonly excludedKind?: string;
  /** Where the entry was declared (project- or pack-relative, as the loader records it). */
  readonly sourceFile?: string;
  /** The contributing pack, for a pack entry. */
  readonly packageName?: string;
}
