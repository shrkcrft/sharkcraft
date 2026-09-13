import type { IUnreadFile } from './unread-file.ts';

/**
 * What the one reader returns: every glob-matched file it READ, and every
 * glob-matched file it did NOT read, with the reason.
 *
 * The second half is the point. A reader that drops an over-cap file without
 * saying so turns "a forbidden token in a 1.7MB file" into "examined 1 of 1 ✓":
 * every plane counted its expected scope from what was read, so the dropped
 * file was invisible to every coverage record built on top of it. Returning
 * the unread files next to the read ones means no caller can build coverage
 * without choosing, explicitly, what to do with them.
 */
export interface IMatchedFiles {
  /**
   * Project-relative POSIX path → content, for every matched file that was
   * read. A fresh map per call, because callers filter and partition it.
   */
  readonly files: Map<string, string>;
  /** Matched files the reader did not read, sorted by path. */
  readonly unread: readonly IUnreadFile[];
}
