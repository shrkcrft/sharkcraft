import type { IVerdictCoverage } from '../verdict/verdict-coverage.ts';
import { ExpectEmptyAcceptedBy } from './expect-empty-accepted-by.ts';
import type { IRuleEmptinessInput } from './i-rule-emptiness-input.ts';
import type { ISettledRuleEmptiness } from './i-settled-rule-emptiness.ts';
import type { IUnitLiveness } from './i-unit-liveness.ts';
import { RuleEmptiness } from './rule-emptiness.ts';
import { RuleEmptinessCause } from './rule-emptiness-cause.ts';
import { UnitLivenessState } from './unit-liveness-state.ts';

const EMPTIED_BY_NEGATIONS_REASON =
  'matched nothing — its own negations exclude every file its inclusion globs select';
/** THE words of the rule-level fence acceptance (one string for every surface). */
const FENCE_REASON = 'the rule asserts an empty set';
const LABELS_SHOWN = 5;

/**
 * THE settle for a rule that yielded nothing (round 13) — every plane's
 * "matched nothing" site calls it, so no plane can accept an empty rule by its
 * own reckoning. First match wins:
 *
 *   1. `unitsMatched > 0`             → Matched (not empty).
 *   2. a matched file was unread      → Unread (PARTIAL via the read scope; never empty, never failOnEmpty's 1).
 *   3. `assertsEmptyOutput` (baselines' rule-level `expectEmpty`):
 *        every primary INCLUSION unit live or intended-empty → AssertedEmptyOutput (accepted);
 *        any dead / unproven / not-effective one            → Stale(DeadInput) — a fence over a dead input proves nothing.
 *   4. `emptiedByNegations`           → EmptiedByNegations (skipped).
 *   5. `filesMatched === 0`:
 *        every primary inclusion unit IntendedEmpty         → IntendedEmpty (accepted — WentLive counts as live);
 *        otherwise                                          → Stale(NoFiles).
 *   6. files matched, 0 units came out → Stale(NoUnits) — NEVER assertable: that is the stale-extractor loud skip.
 *
 * A skipped state `fails` iff `failOnEmpty` — which the caller takes from the
 * ONE failOnEmpty authority, `failsWhenEmpty(rule)`.
 */
export function settleRuleEmptiness(input: IRuleEmptinessInput): ISettledRuleEmptiness {
  if (input.unitsMatched > 0) return { state: RuleEmptiness.Matched, skipped: false, fails: false };
  if (input.unread) return { state: RuleEmptiness.Unread, skipped: false, fails: false };
  const inclusion = primaryUnits(input).filter((u) => !u.unit.startsWith('!'));

  if (input.assertsEmptyOutput === true) {
    const deadInputs = inclusion.filter(
      (u) =>
        u.state === UnitLivenessState.Dead ||
        u.state === UnitLivenessState.Unproven ||
        (u.state === UnitLivenessState.WentLive && !u.effective),
    );
    if (deadInputs.length > 0) {
      return stale(
        input,
        RuleEmptinessCause.DeadInput,
        `expectEmpty asserts an empty output, but its input selector matched nothing (${labelList(deadInputs)}) — an empty result over a dead input proves nothing; fix the selector, or mark a planned input { pattern, expectEmpty: true }`,
      );
    }
    const fence: IVerdictCoverage = {
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      unit: input.unitLabel,
      expected: 0,
      examined: 0,
      reason: FENCE_REASON,
      acceptedBy: ExpectEmptyAcceptedBy.Rule,
    };
    return { state: RuleEmptiness.AssertedEmptyOutput, skipped: false, fails: false, coverage: fence };
  }

  if (input.emptiedByNegations === true) {
    return {
      state: RuleEmptiness.EmptiedByNegations,
      skipped: true,
      fails: input.failOnEmpty,
      skipReason: input.emptiedReason ?? EMPTIED_BY_NEGATIONS_REASON,
    };
  }

  if (input.filesMatched === 0) {
    const acceptance = input.liveness.acceptance;
    const allIntended =
      inclusion.length > 0 && inclusion.every((u) => u.state === UnitLivenessState.IntendedEmpty);
    if (allIntended && acceptance !== undefined) {
      return { state: RuleEmptiness.IntendedEmpty, skipped: false, fails: false, coverage: acceptance };
    }
    return stale(input, RuleEmptinessCause.NoFiles, input.noFilesReason);
  }
  return stale(input, RuleEmptinessCause.NoUnits, input.noUnitsReason);
}

function primaryUnits(input: IRuleEmptinessInput): readonly IUnitLiveness[] {
  const lists = input.primaryLists;
  if (lists === undefined) return input.liveness.units;
  return input.liveness.units.filter((u) => lists.includes(u.list));
}

function stale(input: IRuleEmptinessInput, cause: RuleEmptinessCause, skipReason: string): ISettledRuleEmptiness {
  return { state: RuleEmptiness.Stale, cause, skipped: true, fails: input.failOnEmpty, skipReason };
}

function labelList(units: readonly IUnitLiveness[]): string {
  const shown = units.slice(0, LABELS_SHOWN).map((u) => {
    const why = u.state === UnitLivenessState.Unproven ? 'unproven' : (u.deadReason ?? 'matched nothing');
    return `${u.label}: ${why}`;
  });
  const more = units.length > LABELS_SHOWN ? `, +${units.length - LABELS_SHOWN} more` : '';
  return `${shown.join('; ')}${more}`;
}
