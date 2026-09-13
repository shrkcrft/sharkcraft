import type { IVerdictCoverage } from '@shrkcrft/core';

/**
 * One registration idiom's role coverage, as the registration-graph QUERIES
 * fold it (round 13, P4): `wiring unprovided | orphans`, finish's unprovided
 * sub-gate and MCP `get_wiring_graph`. Measured by THE role authority
 * (`measureRegistrationRoles`, the one `gates check` / `gates coverage` read),
 * so an absence query can no longer print a ✓ over a declared / provided /
 * consumed role that matched no file.
 */
export interface IIdiomRoleCoverage {
  /** The idiom's `name` — the subject its records are settled under. */
  readonly idiom: string;
  /** `measureRegistrationRoles(...).coverage` — `examined N of 3 roles`, or the read-scope record. */
  readonly coverage: IVerdictCoverage;
  /** Its settle record B (`IRegistrationRoles.unitAcceptance`), when a role unit is marked expectEmpty. */
  readonly unitAcceptance?: IVerdictCoverage;
  /**
   * A role left a matched file unread, so {@link coverage} is the read-scope
   * record — the graph's own read-scope record names the same files, so a
   * query that carries that record drops this one rather than name them twice.
   */
  readonly readGap: boolean;
}
