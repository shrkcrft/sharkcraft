import type { UnreadFileReason } from './unread-file-reason.ts';

/** A file a rule's globs matched that the one reader did not read. */
export interface IUnreadFile {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly reason: UnreadFileReason;
  /** Size on disk, when the stat succeeded. */
  readonly bytes?: number;
}
