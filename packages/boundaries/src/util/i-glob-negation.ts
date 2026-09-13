/**
 * A LIVE negation of a gate-plane glob list and what it removes: the files its
 * list's inclusion globs select that it takes out of scope (read, or matched
 * but unread). `gates coverage` prints each one, so the scope a `!` narrowed is
 * visible on the surface the author already reads.
 */
export interface IGlobNegation {
  /** The negation as written (`!src/**\/*.spec.ts`). */
  readonly glob: string;
  /** Files it excludes from the list's positive set (at least 1). */
  readonly excludes: number;
}
