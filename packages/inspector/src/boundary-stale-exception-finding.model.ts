import type { IBoundaryStaleException } from '@shrkcrft/boundaries';

/**
 * A stale exception, located at the rule file that declares it — so it flows
 * through the changed-scope filter like a violation keyed on the rule source:
 * it fails a changeset that edits the rule file (or escalates it), and is
 * legacy otherwise.
 */
export interface IBoundaryStaleExceptionFinding extends IBoundaryStaleException {
  /** Project-relative path of the rule's source file. */
  readonly file: string;
}
