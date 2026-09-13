import {
  resolveSourceGlobs,
  UnitLivenessState,
  type IRegistrationIdiom,
  type ISettledUnitLiveness,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import { inspectSource, type ISourceInspection } from '../extract/inspect-source.ts';
import { sourceLivenessRequest } from '../extract/source-liveness-request.ts';
import { settleGlobLists } from '../util/settle-glob-lists.ts';
import { readScopeCoverage, readScopeOfLists } from '../util/read-scope-coverage.ts';
import type { IReadScope } from '../util/read-scope.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import type { IRegistrationRoles } from './i-registration-roles.ts';

/**
 * Measure every role of one registration idiom with `inspectSource`, the
 * primitive every plane's coverage adapter uses.
 *
 * This is the ONE authority for "is this idiom empty?" and "which role examined
 * nothing?". `gates check` (`runRegistrationPlane`), `gates coverage`
 * (`matchRegistration`) and — round 13 (P4) — the registration-graph queries
 * (`wiring unprovided | orphans`, finish's unprovided sub-gate, MCP
 * `get_wiring_graph`, through `measureIdiomRoleCoverage`) all call it, so they
 * cannot drift apart on either question. That is how a `failOnEmpty` idiom used
 * to FAIL in one verb and pass with a ✓ in the other — and how `wiring
 * unprovided` printed a ✓ over a declared role that matched no file. (It moved
 * here from the CLI's gates, which re-export it: the MCP server cannot import
 * the CLI.)
 *
 * A role whose globs matched a file the reader did not read (over the read
 * cap) is neither "0 files" nor "0 tokens": it matched something it could not
 * examine. The idiom's coverage is then the file record (`readScopeCoverage`,
 * the one fold every plane uses), and the idiom is never `empty`, so a
 * failOnEmpty idiom settles PARTIAL (2), not FAILED (1).
 */
export function measureRegistrationRoles(
  cwd: string,
  idiom: IRegistrationIdiom,
  excludeDirs: readonly string[] = [],
): IRegistrationRoles {
  const declared = inspectSource(cwd, idiom.declared, excludeDirs);
  const provided = inspectSource(cwd, idiom.provided, excludeDirs);
  const consumed = inspectSource(cwd, idiom.consumed, excludeDirs);
  const roles: readonly (readonly ['declared' | 'provided' | 'consumed', ISourceInspection])[] = [
    ['declared', declared],
    ['provided', provided],
    ['consumed', consumed],
  ];
  // Round 13 (lane G): the roles' globs settled with their `expectEmpty`
  // markers — THE per-source request `gates coverage` builds too
  // (`sourceLivenessRequest`, labels `declared` / `provided` / `consumed`). Only
  // an idiom that marks a unit pays for it: without a marker there is nothing
  // intended-empty and nothing to accept.
  const marked = [idiom.declared, idiom.provided, idiom.consumed].some((s) => (s.expectEmptyUnits?.length ?? 0) > 0);
  const liveness: ISettledUnitLiveness | undefined = marked
    ? settleGlobLists(
        sourceLivenessRequest(
          cwd,
          [
            { label: 'declared', source: idiom.declared },
            { label: 'provided', source: idiom.provided },
            { label: 'consumed', source: idiom.consumed },
          ],
          excludeDirs,
          idiom.name,
        ),
      )
    : undefined;
  const unexamined: string[] = [];
  // A role whose globs matched no file BECAUSE every inclusion glob asserts its
  // target does not exist yet examined nothing on purpose: it is accepted
  // (settle record B, `unitAcceptance`), never "PARTIAL — consumed (0 files)".
  const accepted: string[] = [];
  const roleErrors: Partial<Record<'declared' | 'provided' | 'consumed', string>> = {};
  for (const [role, insp] of roles) {
    if (insp.error !== undefined) {
      roleErrors[role] = insp.error;
      unexamined.push(`${role} (could not run: ${insp.error})`);
    } else if (insp.filesScanned === 0 && insp.unread.length === 0) {
      if (liveness !== undefined && roleIntendedEmpty(liveness, role)) accepted.push(role);
      else unexamined.push(`${role} (0 files)`);
    } else if (role === 'declared' && insp.ids.length === 0 && insp.unread.length === 0) {
      // The primary selector read files and extracted nothing, which is the
      // plane's "matched nothing". Provided/consumed may legitimately be empty
      // over live files (see IRegistrationRoles.unexamined).
      unexamined.push(`${role} (0 tokens)`);
    }
  }
  const firstError = roles.find(([, insp]) => insp.error !== undefined);
  // Only when some role left a file unread is the idiom's whole read scope
  // measured, in ONE positive walk over the union of its role globs, then
  // selected PER ROLE LIST (`readScopeOfLists`: a file two roles share is
  // counted once, and one role's `!x` never hides another role's file). The
  // common case pays nothing extra.
  const scope: IReadScope | undefined = roles.some(([, insp]) => insp.unread.length > 0)
    ? readScopeOfLists(
        readMatchingFiles(cwd, unionGlobs(idiom), new Set(excludeDirs)),
        [idiom.declared, idiom.provided, idiom.consumed].map((role) => resolveSourceGlobs(role)),
      )
    : undefined;
  // The roles JUDGED are the ones not accepted as intended-empty; an accepted
  // role rides on the acceptance (record B), never as an examined unit.
  const judged = roles.length - accepted.length;
  const roleCoverage: IVerdictCoverage = {
    unit: 'roles',
    expected: judged,
    examined: judged - unexamined.length,
    ...(unexamined.length > 0
      ? { unexamined, reason: 'matched nothing or could not run, so the role selector is probably stale' }
      : {}),
  };
  // Every role intended-empty: the acceptance IS the idiom's coverage — an
  // unsuppressed `{ expected: 0 }` would settle 2 over an accepted idiom.
  const primary = judged === 0 && liveness?.acceptance !== undefined ? liveness.acceptance : roleCoverage;
  return {
    declared,
    provided,
    consumed,
    empty: declared.ids.length === 0 && declared.unread.length === 0,
    unexamined,
    ...(firstError ? { error: `${firstError[0]}: ${firstError[1].error}` } : {}),
    roleErrors,
    coverage: readScopeCoverage(primary, scope),
    ...(liveness?.acceptance !== undefined ? { unitAcceptance: liveness.acceptance } : {}),
    ...(liveness !== undefined ? { liveness } : {}),
  };
}

/** Whether every inclusion glob of a role's `files` is intended-empty (and the role has one). */
function roleIntendedEmpty(liveness: ISettledUnitLiveness, role: string): boolean {
  const inclusion = liveness.units.filter((u) => u.list === `${role}.files` && !u.unit.startsWith('!'));
  return inclusion.length > 0 && inclusion.every((u) => u.state === UnitLivenessState.IntendedEmpty);
}

/** Every glob any role of the idiom walks, deduped. */
function unionGlobs(idiom: IRegistrationIdiom): string[] {
  return [
    ...new Set([
      ...resolveSourceGlobs(idiom.declared),
      ...resolveSourceGlobs(idiom.provided),
      ...resolveSourceGlobs(idiom.consumed),
    ]),
  ];
}
