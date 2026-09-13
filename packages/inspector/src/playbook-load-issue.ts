/**
 * A playbook file that did not take effect: it failed to import, or a pack
 * declares it and it is not on disk. Every playbook it holds is silently
 * absent, so the self-config doctor surfaces each one (and counts the file as
 * unexamined) instead of reporting the registry healthy.
 */
export interface IPlaybookLoadIssue {
  readonly severity: 'warning' | 'error';
  readonly code: 'load-failed' | 'missing-file';
  readonly message: string;
  /** Absolute path of the file. */
  readonly source: string;
  /** Owning pack, when the file is a pack contribution. */
  readonly packageName?: string;
}
