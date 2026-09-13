import type { ContributionKind } from './contribution-kind.ts';

/**
 * One entry a contribution loader ACCEPTED, attributed to its file — the
 * other half of the conservation law `accepted + rejected === declared`
 * (round 12, 12.1). Registry loaders report these through
 * `collectRegistryOutcomes`, so the contributions inventory lists every
 * loader-backed kind structurally (never by regex).
 */
export interface IContributionAcceptedEntry {
  readonly kind: ContributionKind;
  /** Absolute path of the declaring file. */
  readonly file: string;
  /** Owning pack, when the file is a pack contribution. */
  readonly packageName?: string;
  readonly id: string;
  readonly title?: string;
}
