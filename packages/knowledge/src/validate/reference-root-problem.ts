import { describeEntryValue, KnowledgeReferenceRoot } from '@shrkcrft/core';
import type { IReferenceRootProblem } from './i-reference-root-problem.ts';
import { KnowledgeIssueSeverity } from './knowledge-issue-severity.ts';

const ROOTS: readonly string[] = Object.values(KnowledgeReferenceRoot);

/**
 * THE `root` predicate (round 15 follow-up, F7) — the validator
 * (`invalid-reference`) and the stale-check (an INVALID row) both apply it, so
 * `root: pack` on a local entry fails the same way on every surface.
 *
 * `contributedByPack` is the entry's provenance: a pack's entry has a package
 * directory to resolve against, a local entry does not — `root: pack` there is
 * an error, never a silent fallback to the project root (which would read a
 * DIFFERENT file than the author meant and could pass on it).
 *
 * `undefined` when the reference declares no `root`, or a valid one that has
 * an effect. A value that is not a reference object is `referenceShapeProblem`'s
 * to report, not this predicate's.
 */
export function referenceRootProblem(ref: unknown, contributedByPack: boolean): IReferenceRootProblem | undefined {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return undefined;
  const r = ref as { readonly root?: unknown; readonly path?: unknown; readonly count?: unknown };
  if (r.root === undefined) return undefined;
  if (typeof r.root !== 'string' || !ROOTS.includes(r.root)) {
    return {
      severity: KnowledgeIssueSeverity.Error,
      message: `has root ${describeEntryValue(r.root)} — expected one of: ${ROOTS.join(', ')} (absent means ${KnowledgeReferenceRoot.Project})`,
    };
  }
  if (r.root !== KnowledgeReferenceRoot.Pack) return undefined;
  if (!contributedByPack) {
    return {
      severity: KnowledgeIssueSeverity.Error,
      message:
        'sets root: pack, but no pack contributes this entry — only a pack-contributed entry has a pack directory to ' +
        'resolve against; drop `root` (a local path resolves against the project root)',
    };
  }
  if (r.path === undefined && r.count === undefined) {
    return {
      severity: KnowledgeIssueSeverity.Warning,
      message:
        'sets root: pack, which applies to a path (file / directory / symbol@path, contains, matches) or a count ' +
        'source only — it has no effect on this reference',
    };
  }
  return undefined;
}
