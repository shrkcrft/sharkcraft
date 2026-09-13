import type { ISettledUnitLiveness, IVerdictCoverage } from '@shrkcrft/core';
import type { ISourceInspection } from '../extract/inspect-source.ts';

/**
 * What each of a registration idiom's three roles extracted from the live tree:
 * THE answer to "is this idiom empty?" and "which of its roles examined
 * nothing?".
 *
 * `gates check` (the violation check) and `gates coverage` (the stale-selector
 * detector) both read this one measurement. Before it existed they answered
 * "empty" differently: check keyed on the union of every role's tokens, while
 * coverage keyed on the declared role. So a failOnEmpty idiom whose declared
 * glob had moved FAILED coverage while check printed a ✓ over the same tree.
 *
 * Round 13 (P4): it lives in @shrkcrft/boundaries (it moved down from the CLI's
 * gates, which re-export it) so the registration-graph QUERIES read it too —
 * `wiring unprovided | orphans`, finish's unprovided sub-gate and MCP
 * `get_wiring_graph`, which cannot import the CLI. They printed a ✓ over an
 * idiom whose declared role matched no file while `gates check` said NOT
 * VERIFIED on the same tree.
 */
export interface IRegistrationRoles {
  /** The DECLARED role, the idiom's primary selector. Its ids are what a selfTest asserts on. */
  readonly declared: ISourceInspection;
  readonly provided: ISourceInspection;
  readonly consumed: ISourceInspection;
  /**
   * True when the declared role extracted 0 tokens. That is the idiom's
   * "matched nothing", as every other plane defines it on its primary selector.
   * A role error takes precedence: see {@link error}.
   */
  readonly empty: boolean;
  /**
   * Roles that examined nothing, each labelled with its cause. The causes are
   * `declared (0 tokens)`, `provided (0 files)` and `consumed (could not run: …)`.
   *
   * A provided or consumed role that scanned files but extracted no token is
   * NOT listed. Nothing provided is exactly the state the unprovided check
   * reports as a finding, and nothing consumed is an ordinary intermediate
   * state. A role whose globs matched no file at all examined nothing, though.
   * Every "unprovided" verdict over a dead provided role comes from a stale
   * input.
   */
  readonly unexamined: readonly string[];
  /** The first role that could not run, as `<role>: <error>`. */
  readonly error?: string;
  /** Where each role's error came from, so a caller can keep its own primary-side rule. */
  readonly roleErrors: Readonly<Partial<Record<'declared' | 'provided' | 'consumed', string>>>;
  /**
   * `{ unit: 'roles', expected: 3, examined: 3 - unexamined }`. A dead role
   * therefore settles the rule to `partial` (2) in every verb that reads it,
   * and never to a ✓.
   */
  readonly coverage: IVerdictCoverage;
  /**
   * Settle record B for the idiom's intended-empty role units (round 13:
   * `settleUnitLiveness(...).acceptance`, `@shrkcrft/core`) — set by the plane
   * that settles the role globs; absent when no role unit is marked. Every
   * reader folds it beside {@link coverage} through core's `ruleVerdictRecords`,
   * so an acceptance reaches `accepted` at exit 0 and is never dropped.
   */
  readonly unitAcceptance?: IVerdictCoverage;
  /**
   * The three roles' glob units settled with their `expectEmpty` markers
   * (round 13, lane G: `settleGlobLists` over `sourceLivenessRequest`, lists
   * `declared.files` / `provided.files` / `consumed.files`) — what an idiom's
   * rule emptiness is decided from (`settleRuleEmptiness`). Absent when no role
   * marks a unit.
   */
  readonly liveness?: ISettledUnitLiveness;
}
