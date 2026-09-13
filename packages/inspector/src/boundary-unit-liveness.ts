import {
  boundaryRuleScope,
  BoundaryMarkableList,
  settleBoundaryRule,
  unreadEntryMatches,
  withBoundaryRuleSettlement,
  type IBoundaryRule,
  type IBoundaryRuleCoverage,
  type IUnreadFile,
} from '@shrkcrft/boundaries';
import type { IUnitLiveness, IUnitObservation } from '@shrkcrft/core';

/**
 * THE unread re-settle of one boundary rule (round 13; V1-U1, prerequisite P2)
 * — `check boundaries` AND `check boundaries --diff-against` both call it, so an
 * unreadable governed file weighs the same on the gate and on the authoring
 * path. It replaces `withProvableDeadUnits`, which silently DROPPED a claim;
 * the diff path had no such step at all.
 *
 * A "matches nothing" / "does not exist yet" fact is a whole-tree claim made
 * from what was READ. Every negative fact an unread entry could refute is
 * withdrawn (made unknown), and the rule is re-settled through the one boundary
 * settle (`settleBoundaryRule`, `@shrkcrft/boundaries`): such a unit reads
 * Unproven — no dead line, no `accepted by expectEmpty`, a gap in its rule's
 * coverage. What is refutable:
 *
 *   - a `forbiddenImports` / `allowedImports` claim ("matches no import
 *     anywhere") — by any unread entry the rule's `from` globs match;
 *   - a `from` / exemption glob claim ("matched 0 files") — by an unread entry
 *     that glob matches;
 *   - a unit dead by its SHAPE (`cause`) — never: it is proved from the rule alone.
 *
 * A positive fact (a match seen) is kept. The rule's emptiness is re-settled
 * with `readGap`: a rule whose governed files went unread is partial, never
 * "matched nothing" and never failOnEmpty's 1. Unchanged (same object) when
 * nothing is withdrawn and no governed file is unread.
 */
export function boundaryUnitLiveness(
  detail: IBoundaryRuleCoverage,
  rule: IBoundaryRule,
  context: {
    /** Every entry the scan could not read (files, and directories it could not list). */
    readonly unread: readonly IUnreadFile[];
    /** A governed file in the rule's REPORTED scope was not read (the orchestrator's `readGap`). */
    readonly readGap: boolean;
    readonly filesScanned: number;
    readonly fileUniverse: 'scan' | 'edges';
  },
): IBoundaryRuleCoverage {
  const units = detail.unitLiveness;
  if (units === undefined) return detail;
  const scope = boundaryRuleScope(rule);
  const matched = context.unread.filter((u) => unreadEntryMatches(u, scope.include));
  if (matched.length === 0 && !context.readGap) return detail;
  const refutable = (u: IUnitLiveness): boolean => {
    if (u.cause !== undefined) return false;
    if (u.list === BoundaryMarkableList.ForbiddenImports || u.list === BoundaryMarkableList.AllowedImports) {
      return matched.length > 0;
    }
    const glob = u.unit.startsWith('!') ? u.unit.slice(1) : u.unit;
    return matched.some((entry) => unreadEntryMatches(entry, [glob]));
  };
  const observations: IUnitObservation[] = units.map((u) => {
    const withdraw = refutable(u);
    return {
      list: u.list,
      unit: u.unit,
      exists: withdraw && u.exists === false ? undefined : u.exists,
      live: withdraw && u.live === false ? undefined : u.live,
      label: u.label,
      weight: u.weight,
      ...(u.matched !== undefined ? { matched: u.matched } : {}),
      ...(u.liveBecause !== undefined ? { liveBecause: u.liveBecause } : {}),
      ...(u.deadReason !== undefined ? { deadReason: u.deadReason } : {}),
      ...(u.cause !== undefined ? { cause: u.cause } : {}),
    };
  });
  const settlement = settleBoundaryRule({
    rule,
    observations,
    includeGlobs: scope.include,
    filesScanned: context.filesScanned,
    fileUniverse: context.fileUniverse,
    filesInScope: detail.filesInScope,
    exemptFilesInScope: detail.exemptFilesInScope,
    violations: detail.violations,
    unread: context.readGap,
  });
  return withBoundaryRuleSettlement(detail, settlement);
}
