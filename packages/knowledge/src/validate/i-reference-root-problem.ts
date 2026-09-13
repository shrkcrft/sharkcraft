import type { KnowledgeIssueSeverity } from './knowledge-issue-severity.ts';

/**
 * Why one reference's `root` is wrong where it is declared (round 15
 * follow-up, F7). `error`: the reference cannot be resolved as written (an
 * unknown root, `root: pack` on an entry no pack contributes). `warning`: the
 * root is valid but has no effect (nothing path-based to resolve). The
 * validator copies `severity` onto its issue, so both use one enum.
 */
export interface IReferenceRootProblem {
  readonly severity: KnowledgeIssueSeverity;
  readonly message: string;
}
