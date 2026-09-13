import type { IRegistrationIdiom } from '@shrkcrft/core';
import type { IIdiomRoleCoverage } from './i-idiom-role-coverage.ts';
import { measureRegistrationRoles } from './measure-registration-roles.ts';

/**
 * Every idiom's role coverage for the registration-graph queries (round 13,
 * P4), from THE role authority `measureRegistrationRoles` — never re-derived
 * from the graph's token union, which is how `wiring unprovided` printed a ✓
 * over an idiom whose declared role matched no file while `gates check` said
 * NOT VERIFIED over the same tree. `excludeDirs` must be the scan scope the
 * graph was built with (`planeScanExcludeDirs`).
 */
export function measureIdiomRoleCoverage(
  cwd: string,
  idioms: readonly IRegistrationIdiom[],
  excludeDirs: readonly string[] = [],
): IIdiomRoleCoverage[] {
  return idioms.map((idiom) => {
    const roles = measureRegistrationRoles(cwd, idiom, excludeDirs);
    return {
      idiom: idiom.name,
      coverage: roles.coverage,
      ...(roles.unitAcceptance ? { unitAcceptance: roles.unitAcceptance } : {}),
      readGap: [roles.declared, roles.provided, roles.consumed].some((r) => r.unread.length > 0),
    };
  });
}
