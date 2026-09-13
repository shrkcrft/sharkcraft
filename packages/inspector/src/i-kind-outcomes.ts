import type { IContributionLoadFailure } from './contribution-load-failures.ts';
import type { IContributionEntryRejection } from './i-contribution-entry-rejection.ts';

/**
 * What the loaders of a few contribution kinds reported in one run
 * (`collectKindOutcomes`): the entries they refused and the files that never
 * loaded. A `list` verb prints both after its list, so a file that failed to
 * import is never a silently empty list (round 12 review, A-4).
 */
export interface IKindOutcomes {
  readonly rejections: readonly IContributionEntryRejection[];
  readonly loadFailures: readonly IContributionLoadFailure[];
}
