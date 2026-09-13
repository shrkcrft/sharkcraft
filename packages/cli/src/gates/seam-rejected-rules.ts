import { RejectionCause } from '@shrkcrft/core';
import {
  ContributionKind,
  contributionFileLabel,
  formatEntryRejection,
  type IResolvedProjectConfig,
} from '@shrkcrft/inspector';
import type { IGateRuleResult } from './gate-envelope.ts';
import type { GatePlane } from './gate-rule-view.ts';

/**
 * Each gate-plane contribution kind → the plane its rules run on. A kind absent
 * here (`reuse-primitive`) is not a gate plane. Doc references joined in round
 * 13 (P3): their pack slot (`docReferenceFiles`) is declared, so a rejected
 * pack doc-reference rule is an ERRORED row like every other plane's — before,
 * it was a diagnostic string only.
 */
const PLANE_OF_KIND: Readonly<Partial<Record<ContributionKind, GatePlane>>> = {
  [ContributionKind.WiringRule]: 'wiring',
  [ContributionKind.PolicyRule]: 'policy',
  [ContributionKind.Registry]: 'registry',
  [ContributionKind.RegistrationIdiom]: 'registration',
  [ContributionKind.Baseline]: 'baseline',
  [ContributionKind.GeneratedArtifact]: 'generated',
  [ContributionKind.DocReference]: 'doc-reference',
};

/**
 * THE gate-plane reading of a pack element the merge seam refused (round 12
 * review, R12-X1): a configured rule that did NOT run — an ERRORED row, `failed
 * validation — NOT evaluated`, exactly as the boundary plane reports a rejected
 * boundary rule.
 *
 * `resolveProjectConfig` has always returned the structured rejections
 * (`planeOutcomes`), but every gate verb read only the `planeDiagnostics`
 * strings: a pack policy rule whose `files` was negation-only was dropped, never
 * entered the rule denominator, and `gates check` / `policy-lint` / `gates
 * coverage` printed a ✓ at exit 0 over it while `packs contributions` and
 * `packs doctor` exited 1 on the same tree. Every plane reader — `gates
 * check|coverage|list`, `quality`, `policy-lint`, `check wiring`, `registry`,
 * `baseline check`, `generated check`, `finish` — builds its rows here, so they
 * cannot disagree about one rejected rule.
 *
 * A pack plane FILE that failed to import is one errored row per file (the
 * rules inside it are unknown). A `duplicate-id` rejection is NOT a row: the id
 * it collided with is a rule that runs (local wins), so it stays a diagnostic.
 * `planes` narrows to the planes a verb reads; absent = every plane.
 */
export function seamRejectedRules(
  resolved: Pick<IResolvedProjectConfig, 'planeOutcomes' | 'projectRoot'>,
  planes?: readonly GatePlane[],
): (IGateRuleResult & { readonly type: GatePlane })[] {
  const outcomes = resolved.planeOutcomes;
  if (!outcomes) return [];
  const wanted = (kind: ContributionKind): GatePlane | undefined => {
    const plane = PLANE_OF_KIND[kind];
    return plane !== undefined && (planes === undefined || planes.includes(plane)) ? plane : undefined;
  };
  const rows: (IGateRuleResult & { readonly type: GatePlane })[] = [];
  const seen = new Set<string>();
  for (const r of outcomes.rejected) {
    if (r.cause === RejectionCause.DuplicateId) continue;
    const plane = wanted(r.kind);
    if (plane === undefined) continue;
    const file = contributionFileLabel(resolved.projectRoot, r.file);
    const id = r.entryId ?? `${file}[${r.index}]`;
    if (seen.has(`${plane}:${id}`)) continue;
    seen.add(`${plane}:${id}`);
    const pack = r.packageName ? `pack ${r.packageName} ` : '';
    rows.push({
      id,
      type: plane,
      status: 'error',
      severity: 'error',
      counts: {},
      violations: [],
      error:
        `${pack}${plane} rule failed validation at the pack-plane merge seam — NOT evaluated: ` +
        `${formatEntryRejection(r)} (${file})`,
      coverage: { unit: 'rules', expected: 1, examined: 0, subject: id, reason: 'failed validation — NOT evaluated' },
    });
  }
  for (const f of outcomes.loadFailures) {
    const plane = wanted(f.kind);
    if (plane === undefined) continue;
    const file = contributionFileLabel(resolved.projectRoot, f.file);
    const id = `${f.packageName}:${file}`;
    if (seen.has(`${plane}:${id}`)) continue;
    seen.add(`${plane}:${id}`);
    rows.push({
      id,
      type: plane,
      status: 'error',
      severity: 'error',
      counts: {},
      violations: [],
      error: `pack ${f.packageName} ${plane} rule file failed to load — none of its rules was evaluated: ${f.message}`,
      coverage: { unit: 'rules', expected: 1, examined: 0, subject: id, reason: 'the rule file failed to load' },
    });
  }
  return rows;
}
