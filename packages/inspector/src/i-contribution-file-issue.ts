/**
 * A contribution FILE that did not take effect — it failed to import, or a
 * pack declares it and it is not on disk. The registry loaders that used to
 * swallow an import failure (`catch { /* ignore *\/ }`: constructs, decisions,
 * policy checks, feedback rules, context / agent tests) return one of these
 * instead (round 12, 12.1c); `collectRegistryOutcomes` lifts `load-failed`
 * into THE load-failure map like every other registry's.
 */
export interface IContributionFileIssue {
  readonly severity: 'warning' | 'error';
  readonly code: 'load-failed' | 'missing-file';
  readonly message: string;
  /** Absolute path of the file. */
  readonly source: string;
  /** Owning pack, when the file is a pack contribution. */
  readonly packageName?: string;
}
