import { failsWhenEmpty, parseGlobList } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { importPatternSubsumes } from '../scan/import-pattern.ts';
import { unreadEntryMatches, unreadEntryWhollyMatches } from '../util/read-scope-coverage.ts';
import type { IUnreadFile } from '../util/unread-file.ts';
import type {
  BoundaryScopeDecision,
  BoundarySeverity,
  ForbiddenMatchMode,
  IBoundaryPatternOverlap,
  IBoundaryPatternOverlaps,
  IBoundaryRule,
  IBoundaryRuleScope,
  IBoundaryScopeExemption,
} from './boundary-rule.ts';

/**
 * The ONE answer to "is file F in rule R's scope?" and "how severe is R?".
 *
 * Before round 11 four code paths each read `rule.from` on their own — the
 * evaluator, `why-file`, the rule-graph bridge, the changes summary — and the
 * CLI renderers each defaulted an unset severity to `'warning'` while the
 * evaluator enforced it as `'error'` (an author inspecting a rule was told
 * "warning" for a rule that blocks CI). With exemptions in the model, any
 * reader that kept matching `from` alone would keep claiming a rule applies to
 * an exempted file. So every reader calls these, and the evaluator itself
 * decides scope through {@link boundaryScopeDecision}.
 */

/**
 * The test-file shorthand `excludeTests: true` expands to. Deliberately the
 * common layouts only — a repo with another convention lists its own globs in
 * `exemptFiles`.
 */
export const TEST_FILE_GLOBS: readonly string[] = [
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.spec.*',
  '**/*.test.*',
];

/**
 * A rule's source-side scope: the globs that include files and the globs that
 * exempt them.
 *
 * A `from` entry starting with `!` is normalised into an exemption — the syntax
 * authors already type (`'!**\/*.spec.ts'`) used to compile to a literal `!`
 * glob that matched nothing, silently, while the spec file stayed governed.
 *
 * `from` is split by core's ONE `!` parser (`parseGlobList`), the same one
 * every gate plane selects through. The planes differ in what a negation DOES,
 * never in what it is: here it EXEMPTS (the file is still scanned, its
 * violations are marked suppressed and counted — the boundary counterpart of
 * policy `exemptFiles`); on the gate planes it EXCLUDES (out of scope). Both
 * share one liveness rule: a negation is alive iff it removes at least one
 * file from its own positive set. A bare `!` is rejected at load
 * (`globListProblem`), so the empty-glob guard below only meets an
 * unvalidated rule.
 */
export function boundaryRuleScope(rule: IBoundaryRule): IBoundaryRuleScope {
  const { include, exclude } = parseGlobList(rule.from ?? []);
  const exemptions: IBoundaryScopeExemption[] = [];
  for (const glob of exclude) {
    if (glob.length > 0) exemptions.push({ glob, origin: 'from-negation' });
  }
  for (const glob of rule.exemptFiles ?? []) exemptions.push({ glob, origin: 'exemptFiles' });
  if (rule.excludeTests === true) {
    for (const glob of TEST_FILE_GLOBS) exemptions.push({ glob, origin: 'excludeTests' });
  }
  return { include, exempt: exemptions.map((e) => e.glob), exemptions };
}

/**
 * Where `relPath` sits relative to a precomputed scope: `in` (governed),
 * `exempt` (inside `from`, but exempted — still scanned, its violations are
 * MARKED suppressed, never dropped), or `out`.
 */
export function boundaryScopeDecision(scope: IBoundaryRuleScope, relPath: string): BoundaryScopeDecision {
  if (!matchesAny(relPath, scope.include)) return 'out';
  if (scope.exempt.length > 0 && matchesAny(relPath, scope.exempt)) return 'exempt';
  return 'in';
}

/**
 * {@link boundaryScopeDecision} for an UNREAD entry: a file the scan matched
 * but could not read, or a directory it could not list. A file is governed
 * exactly as a read one would be. A directory is governed when an include glob
 * could match beneath it and no exemption covers ALL of it — through the one
 * unread-entry test every plane uses (`unreadEntryMatches` /
 * `unreadEntryWhollyMatches`).
 */
export function boundaryScopeCoversUnread(scope: IBoundaryRuleScope, u: IUnreadFile): boolean {
  if (!unreadEntryMatches(u, scope.include)) return false;
  return !(scope.exempt.length > 0 && unreadEntryWhollyMatches(u, scope.exempt));
}

/** {@link boundaryScopeDecision} for one rule — the call every reader uses. */
export function boundaryRuleCovers(rule: IBoundaryRule, relPath: string): BoundaryScopeDecision {
  return boundaryScopeDecision(boundaryRuleScope(rule), relPath);
}

/** The severity the evaluator ENFORCES: an unset severity is `error`. */
export function boundaryRuleSeverity(rule: Pick<IBoundaryRule, 'severity'>): BoundarySeverity {
  return rule.severity ?? 'error';
}

/**
 * Whether a rule whose scope matched no scanned file is a FAILURE rather than a
 * skip — the gate planes' `failOnEmpty` default: on for `error` rules. The
 * boundary VIEW of the one failOnEmpty authority (`failsWhenEmpty`,
 * `@shrkcrft/core`), never a second default: an `info` rule, like a `warning`
 * one, defaults off.
 */
export function boundaryRuleFailsOnEmpty(rule: Pick<IBoundaryRule, 'severity' | 'failOnEmpty'>): boolean {
  return failsWhenEmpty({
    ...(rule.failOnEmpty !== undefined ? { failOnEmpty: rule.failOnEmpty } : {}),
    severity: boundaryRuleSeverity(rule) === 'error' ? 'error' : 'warning',
  });
}

/** How the rule's `forbiddenImports` / `exceptions[].target` match: package semantics unless opted out. */
export function boundaryForbiddenMatch(rule: Pick<IBoundaryRule, 'forbiddenMatch'>): ForbiddenMatchMode {
  return rule.forbiddenMatch ?? 'package';
}

/**
 * The patterns of one rule that can never change its verdict (round 12,
 * R12-5.3 / R12-5.6) — the ONE answer the evaluator (coverage `subsumedBy` /
 * `shadowedBy`, the shadowed dead unit), `boundaries explain` and MCP
 * `get_boundary_rule` read, through the one subsumption proof beside the
 * matcher (`importPatternSubsumes`).
 *
 *   - `redundantForbidden`: a `forbiddenImports` entry another KEPT entry
 *     already covers — `@scope/pkg/**` next to `@scope/pkg` under package
 *     semantics, the `pkg` + `pkg/**` helper consumers wrote while a bare
 *     pattern missed subpaths. Of two entries covering each other the FIRST is
 *     kept, and a coverer is always a kept entry, so deleting every redundant
 *     one never narrows the fence. INFO only.
 *   - `shadowedAllowed`: an `allowedImports` entry a forbidden entry covers.
 *     Forbidden is checked first and allowed never re-admits, so it can never
 *     admit an import — under package semantics a bare forbidden package
 *     shadows every allowed subpath of it (a carve-out alpha.30 honoured).
 */
export function boundaryPatternOverlaps(
  rule: Pick<IBoundaryRule, 'forbiddenImports' | 'allowedImports' | 'forbiddenMatch'>,
): IBoundaryPatternOverlaps {
  const mode = boundaryForbiddenMatch(rule);
  const forbidden = rule.forbiddenImports ?? [];
  const allowed = rule.allowedImports ?? [];
  const covers = (outer: number, inner: number): boolean =>
    importPatternSubsumes(forbidden[outer]!, forbidden[inner]!, mode);
  const coveredBy = new Map<number, number>();
  for (let i = 0; i < forbidden.length; i += 1) {
    for (let j = 0; j < forbidden.length; j += 1) {
      if (j === i || !covers(j, i)) continue;
      if (j > i && covers(i, j)) continue; // mutual cover (e.g. a duplicate): the FIRST is kept
      coveredBy.set(i, j);
      break;
    }
  }
  // A coverer must itself be KEPT: were both ends of a chain flagged, deleting
  // every redundant entry could drop the only one that enforced them.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [i, j] of coveredBy) {
      if (!coveredBy.has(j)) continue;
      const kept = forbidden.findIndex((_, k) => k !== i && !coveredBy.has(k) && covers(k, i));
      if (kept >= 0) {
        coveredBy.set(i, kept);
      } else {
        coveredBy.delete(i);
        changed = true;
      }
    }
  }
  const redundantForbidden: IBoundaryPatternOverlap[] = [...coveredBy]
    .sort(([a], [b]) => a - b)
    .map(([index, by]) => ({ pattern: forbidden[index]!, index, by: forbidden[by]! }));
  const shadowedAllowed: IBoundaryPatternOverlap[] = [];
  allowed.forEach((pattern, index) => {
    const shadows = (k: number): boolean => importPatternSubsumes(forbidden[k]!, pattern, mode, 'exact');
    let by = forbidden.findIndex((_, k) => !coveredBy.has(k) && shadows(k));
    if (by < 0) by = forbidden.findIndex((_, k) => shadows(k));
    if (by >= 0) shadowedAllowed.push({ pattern, index, by: forbidden[by]! });
  });
  return { redundantForbidden, shadowedAllowed };
}
