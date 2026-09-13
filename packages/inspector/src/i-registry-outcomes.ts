import type { IContributionAcceptedEntry } from './i-contribution-accepted-entry.ts';
import type { IContributionEntryRejection } from './i-contribution-entry-rejection.ts';
import type { IContributionLoadFailure } from './contribution-load-failures.ts';

/**
 * What EVERY registry loader reported in one run (`collectRegistryOutcomes`):
 * the files that failed to load, the entries each loader refused, and the
 * entries it accepted, each attributed to its file. The contributions
 * inventory, `packs doctor`, `packs list` and the self-config doctor read this
 * one run — never a second pass over the loaders (round 12, 12.1).
 */
export interface IRegistryOutcomes {
  readonly loadFailures: readonly IContributionLoadFailure[];
  readonly rejections: readonly IContributionEntryRejection[];
  readonly accepted: readonly IContributionAcceptedEntry[];
}
