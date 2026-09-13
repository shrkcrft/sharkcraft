/**
 * Why the one reader (`readMatchingFiles`) matched a file against a rule's
 * globs but did not read it. Either way the file is IN the rule's scope and
 * was never examined, which is a coverage gap. It is never narrowing.
 */
export enum UnreadFileReason {
  /** Larger than `MAX_SCAN_FILE_BYTES`, so the reader skipped it. */
  OverReadCap = 'over-read-cap',
  /**
   * A regenerated file (`generated check`'s temp tree) larger than
   * `MAX_REGEN_FILE_BYTES`, so it was never read or byte-compared.
   */
  OverRegenCap = 'over-regen-cap',
  /** The stat or the read failed (permissions, or a delete racing the walk). */
  Unreadable = 'unreadable',
  /**
   * A DIRECTORY the walk could not list (permissions): no file beneath it was
   * ever matched, let alone read. The entry's `path` ends in `/` (the root is
   * `./`), and it is in front of every rule whose globs could match beneath it
   * — `unreadEntryMatches`, the one test every plane uses. It used to be a
   * silent `return`, so a violation under a `chmod 000` directory read as a
   * clean `0` with full coverage.
   */
  UnreadableDirectory = 'unreadable-directory',
}
