import type { IVerdictCoverage } from '@shrkcrft/core';
import type { IUnreadFile } from '../util/unread-file.ts';

/**
 * What a registration-graph ABSENCE query proves over what the graph READ.
 *
 * `wiring unprovided` claims "no provider anywhere"; `wiring orphans` claims
 * "no consumer anywhere". Both are claims about files the graph never saw
 * when an idiom glob matched a file over the read cap. So an absence whose
 * missing site could sit in such a file is demoted from a finding to
 * `unproven`, and the demoted tokens are named in the coverage. The same rule
 * the registry plane applies: only a positive finding survives an incomplete
 * inventory.
 */
export interface IRegistrationQueryVerdict<T extends { readonly token: string }> {
  /** Absences the read proves: no unread file could hold the missing site. */
  readonly findings: readonly T[];
  /**
   * Candidates an unread file could refute: the missing role's globs match a
   * file the reader did not read. Never a finding, and never a pass.
   */
  readonly unproven: readonly T[];
  /**
   * What to settle against: the graph's read scope (the unread files, named),
   * every idiom's ROLE records (round 13, P4 — `examined 2 of 3 roles …
   * declared (0 files)`, plus any expectEmpty acceptance; subject = the
   * idiom), and, when candidates were demoted, the demoted tokens. Never
   * empty when an idiom was measured: a role that examined nothing is a
   * shortfall here exactly as on `gates check`.
   */
  readonly coverage: readonly IVerdictCoverage[];
  /** Core's `coverageShortfall` of each record, in order. */
  readonly shortfalls: readonly string[];
  /** Every file the idioms matched that the reader did not read. */
  readonly unread: readonly IUnreadFile[];
}
