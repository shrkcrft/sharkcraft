import type { IUnreadFile } from './unread-file.ts';

/**
 * What one rule's walk covered: the glob-matched files in its scope that were
 * READ, and the ones that were not. `readScopeCoverage` folds this into the
 * rule's coverage record. It is the only function that decides how an unread
 * file changes a verdict.
 */
export interface IReadScope {
  /** Glob-matched files in the rule's scope that the reader read. */
  readonly read: number;
  /** Glob-matched files in the rule's scope that it did not read. */
  readonly unread: readonly IUnreadFile[];
}
