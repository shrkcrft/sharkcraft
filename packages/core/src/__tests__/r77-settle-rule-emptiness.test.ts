/**
 * r77 — THE settle for a rule that yielded nothing (round 13, DECISIONS §2).
 *
 * Every plane's "matched nothing" site calls `settleRuleEmptiness`. Locked
 * here: every `RuleEmptiness` state; IntendedEmpty is NoFiles, never NoUnits
 * ("0 ids out of live files" is the stale-extractor loud skip, never
 * assertable); WentLive counts as live; nothing unread; the baselines fence
 * holds only over live or intended-empty inputs (a fence over a dead input is
 * Stale — V2 f1d); and the failOnEmpty answer comes from the ONE authority,
 * `failsWhenEmpty`. The settle takes no mode: a `ceiling` baseline reaches it
 * through the same inputs, so its real branch (the extractor UNIT count — never
 * the serialised text — deciding an empty measurement) is locked end to end by
 * the CLI's r77-gate-plane-expect-empty, not by comparing this pure function
 * with itself.
 */
import { describe, expect, test } from 'bun:test';
import {
  EMPTY_RULE_ADVICE,
  ExpectEmptyAcceptedBy,
  failsWhenEmpty,
  formatEmptyRuleAdvice,
  RuleEmptiness,
  RuleEmptinessCause,
  ruleAssertsEmptyOutput,
  settleRuleEmptiness,
  settleUnitLiveness,
  settleVerdict,
  UnitDeadWeight,
  type IRuleEmptinessInput,
  type ISettledUnitLiveness,
  type IUnitMark,
  type IUnitObservation,
} from '../index.ts';

function obs(unit: string, exists: boolean | undefined, live: boolean | undefined, list = 'files'): IUnitObservation {
  return { list, unit, exists, live, deadReason: live === false ? 'matched 0 files' : undefined };
}

function liveness(observations: readonly IUnitObservation[], marked: readonly string[] = []): ISettledUnitLiveness {
  const marks: IUnitMark[] = observations
    .filter((o) => marked.includes(o.unit))
    .map((o) => ({ list: o.list, unit: o.unit }));
  return settleUnitLiveness({ subject: 'r', unitLabel: 'globs', weight: UnitDeadWeight.Advisory, observations, marks });
}

function input(over: Partial<IRuleEmptinessInput> & Pick<IRuleEmptinessInput, 'liveness'>): IRuleEmptinessInput {
  return {
    subject: 'r',
    unitLabel: 'ids',
    filesMatched: 0,
    unitsMatched: 0,
    unread: false,
    failOnEmpty: true,
    noFilesReason: '0 files matched the source globs',
    noUnitsReason: '0 ids extracted from the source side',
    ...over,
  };
}

const PLANNED = liveness([obs('src/plugins/**/*.ts', false, false)], ['src/plugins/**/*.ts']);

describe('every state', () => {
  test('Matched: at least one unit came out — not empty', () => {
    expect(settleRuleEmptiness(input({ liveness: PLANNED, filesMatched: 2, unitsMatched: 3 }))).toEqual({
      state: RuleEmptiness.Matched,
      skipped: false,
      fails: false,
    });
  });

  test('Unread: nothing came out but a matched file went unread — never empty, even when every unit is marked', () => {
    expect(settleRuleEmptiness(input({ liveness: PLANNED, unread: true }))).toEqual({
      state: RuleEmptiness.Unread,
      skipped: false,
      fails: false,
    });
  });

  test('IntendedEmpty: 0 files, nothing unread, every primary inclusion unit intended-empty — accepted, never failed', () => {
    const s = settleRuleEmptiness(input({ liveness: PLANNED, failOnEmpty: true }));
    expect(s).toMatchObject({ state: RuleEmptiness.IntendedEmpty, skipped: false, fails: false });
    // the rule's coverage IS the unit acceptance — the same object, so the envelope folds it once
    expect(s.coverage).toBe(PLANNED.acceptance);
    expect(settleVerdict(0, [s.coverage!])).toMatchObject({
      exit: 0,
      accepted: ['r: accepted by expectEmpty: examined 0 of 1 globs, 1 asserted empty — matched 0 files: src/plugins/**/*.ts'],
    });
  });

  test('Stale(NoFiles): 0 files and an unmarked dead inclusion unit — the loud skip, failOnEmpty decides 1 vs 2', () => {
    const dead = liveness([obs('src/typo/**', false, false)]);
    expect(settleRuleEmptiness(input({ liveness: dead, failOnEmpty: true }))).toEqual({
      state: RuleEmptiness.Stale,
      cause: RuleEmptinessCause.NoFiles,
      skipped: true,
      fails: true,
      skipReason: '0 files matched the source globs',
    });
    expect(settleRuleEmptiness(input({ liveness: dead, failOnEmpty: false }))).toMatchObject({
      state: RuleEmptiness.Stale,
      skipped: true,
      fails: false,
    });
  });

  test('partial marking is not enough: one planned unit beside an unmarked dead one is Stale(NoFiles)', () => {
    const mixed = liveness([obs('src/plugins/**', false, false), obs('src/typo/**', false, false)], ['src/plugins/**']);
    expect(settleRuleEmptiness(input({ liveness: mixed }))).toMatchObject({
      state: RuleEmptiness.Stale,
      cause: RuleEmptinessCause.NoFiles,
    });
  });

  test('WentLive counts as live: a marked unit whose target exists (all of it excluded) blocks IntendedEmpty', () => {
    const went = liveness([obs('src/plugins/**', true, false)], ['src/plugins/**']);
    expect(settleRuleEmptiness(input({ liveness: went }))).toMatchObject({
      state: RuleEmptiness.Stale,
      cause: RuleEmptinessCause.NoFiles,
      skipped: true,
    });
  });

  test('negations are not inclusion units: a planned inclusion beside an unmarked dead negation is IntendedEmpty', () => {
    const l = liveness([obs('src/plugins/**', false, false), obs('!src/**/*.gen.ts', false, false)], ['src/plugins/**']);
    expect(settleRuleEmptiness(input({ liveness: l })).state).toBe(RuleEmptiness.IntendedEmpty);
  });

  test('a primary list with no inclusion unit asserts nothing: Stale(NoFiles)', () => {
    expect(settleRuleEmptiness(input({ liveness: liveness([]) }))).toMatchObject({
      state: RuleEmptiness.Stale,
      cause: RuleEmptinessCause.NoFiles,
    });
  });

  test('primaryLists: only the primary list decides — a planned declared side is accepted over a dead registered glob', () => {
    const l = liveness(
      [obs('src/handlers-v2/*.ts', false, false, 'declared.files'), obs('src/moved/*.ts', false, false, 'registered.files')],
      ['src/handlers-v2/*.ts'],
    );
    expect(settleRuleEmptiness(input({ liveness: l, primaryLists: ['declared.files'] })).state).toBe(
      RuleEmptiness.IntendedEmpty,
    );
    // without the filter the dead registered glob is part of "every inclusion unit"
    expect(settleRuleEmptiness(input({ liveness: l })).state).toBe(RuleEmptiness.Stale);
  });

  test('EmptiedByNegations: the list\'s own negations emptied it — skipped, failOnEmpty decides, the plane words it', () => {
    const l = liveness([obs('src/gen/**/*.ts', true, false), obs('!src/gen/**/*.generated.ts', true, true)]);
    expect(settleRuleEmptiness(input({ liveness: l, emptiedByNegations: true, filesMatched: 0 }))).toEqual({
      state: RuleEmptiness.EmptiedByNegations,
      skipped: true,
      fails: true,
      skipReason: 'matched nothing — its own negations exclude every file its inclusion globs select',
    });
    expect(
      settleRuleEmptiness(input({ liveness: l, emptiedByNegations: true, failOnEmpty: false, emptiedReason: 'custom' })),
    ).toEqual({ state: RuleEmptiness.EmptiedByNegations, skipped: true, fails: false, skipReason: 'custom' });
  });
});

describe('NoFiles, never NoUnits', () => {
  test('files matched but 0 units came out is Stale(NoUnits) — never assertable, however the units are marked', () => {
    // A marked glob that went live over files yielding 0 ids: the stale-extractor loud skip (J1 must-fix d).
    const went = liveness([obs('src/plugins/**', true, true)], ['src/plugins/**']);
    expect(settleRuleEmptiness(input({ liveness: went, filesMatched: 3 }))).toEqual({
      state: RuleEmptiness.Stale,
      cause: RuleEmptinessCause.NoUnits,
      skipped: true,
      fails: true,
      skipReason: '0 ids extracted from the source side',
    });
    // Even an (impossible) all-intended ledger cannot accept 0 units out of matched files.
    expect(settleRuleEmptiness(input({ liveness: PLANNED, filesMatched: 1 })).cause).toBe(RuleEmptinessCause.NoUnits);
  });
});

describe('the baselines fence (AssertedEmptyOutput)', () => {
  test('over LIVE inputs the empty output is the verified state — accepted by the rule-level expectEmpty', () => {
    const inputs = liveness([obs('src/ui/**/*.ts', true, true)]);
    const s = settleRuleEmptiness(
      input({ liveness: inputs, filesMatched: 4, assertsEmptyOutput: true, unitLabel: 'entries', failOnEmpty: false }),
    );
    expect(s).toEqual({
      state: RuleEmptiness.AssertedEmptyOutput,
      skipped: false,
      fails: false,
      coverage: {
        subject: 'r',
        unit: 'entries',
        expected: 0,
        examined: 0,
        reason: 'the rule asserts an empty set',
        acceptedBy: ExpectEmptyAcceptedBy.Rule,
      },
    });
    expect(settleVerdict(0, [s.coverage!])).toMatchObject({
      exit: 0,
      accepted: ['r: accepted by expectEmpty: true: 0 entries to examine — the rule asserts an empty set'],
    });
  });

  test('over an INTENDED-EMPTY input the two levels compose: still AssertedEmptyOutput', () => {
    expect(settleRuleEmptiness(input({ liveness: PLANNED, assertsEmptyOutput: true })).state).toBe(
      RuleEmptiness.AssertedEmptyOutput,
    );
  });

  test('a fence over a DEAD input is Stale(DeadInput) — V2 f1d: an empty result over a dead input proves nothing', () => {
    const dead = liveness([obs('src/ui/**/*.ts', true, true), obs('src/typo/**', false, false)]);
    const s = settleRuleEmptiness(input({ liveness: dead, filesMatched: 4, assertsEmptyOutput: true, failOnEmpty: true }));
    expect(s).toMatchObject({ state: RuleEmptiness.Stale, cause: RuleEmptinessCause.DeadInput, skipped: true, fails: true });
    expect(s.skipReason).toBe(
      'expectEmpty asserts an empty output, but its input selector matched nothing (src/typo/**: matched 0 files) — an empty result over a dead input proves nothing; fix the selector, or mark a planned input { pattern, expectEmpty: true }',
    );
    expect(s.coverage).toBeUndefined();
    // soft (failOnEmpty false): NOT VERIFIED, never the old silent green
    expect(
      settleRuleEmptiness(input({ liveness: dead, filesMatched: 4, assertsEmptyOutput: true, failOnEmpty: false })),
    ).toMatchObject({ state: RuleEmptiness.Stale, skipped: true, fails: false });
  });

  test('a went-live input that contributes nothing is a dead input too', () => {
    const went = liveness([obs('src/ui/**', true, false)], ['src/ui/**']);
    expect(settleRuleEmptiness(input({ liveness: went, assertsEmptyOutput: true })).cause).toBe(
      RuleEmptinessCause.DeadInput,
    );
  });

  test('an unread input is Unread first (PARTIAL), and a non-empty output is Matched (the ledger drifts normally)', () => {
    expect(settleRuleEmptiness(input({ liveness: PLANNED, assertsEmptyOutput: true, unread: true })).state).toBe(
      RuleEmptiness.Unread,
    );
    expect(
      settleRuleEmptiness(input({ liveness: PLANNED, assertsEmptyOutput: true, unitsMatched: 1, filesMatched: 1 })).state,
    ).toBe(RuleEmptiness.Matched);
  });

  test('a command compute has no input units to judge: the fence holds as it does today', () => {
    expect(settleRuleEmptiness(input({ liveness: liveness([]), assertsEmptyOutput: true })).state).toBe(
      RuleEmptiness.AssertedEmptyOutput,
    );
  });

  test('ruleAssertsEmptyOutput is the one read of the rule-level field', () => {
    expect(ruleAssertsEmptyOutput({ expectEmpty: true })).toBe(true);
    expect(ruleAssertsEmptyOutput({ expectEmpty: false })).toBe(false);
    expect(ruleAssertsEmptyOutput({})).toBe(false);
  });
});

describe('one failOnEmpty authority, one empty-rule advice', () => {
  test('the failOnEmpty input is failsWhenEmpty\'s answer: error rules fail on empty by default, warning rules do not', () => {
    const dead = liveness([obs('src/typo/**', false, false)]);
    expect(settleRuleEmptiness(input({ liveness: dead, failOnEmpty: failsWhenEmpty({}) })).fails).toBe(true);
    expect(settleRuleEmptiness(input({ liveness: dead, failOnEmpty: failsWhenEmpty({ severity: 'warning' }) })).fails).toBe(
      false,
    );
    expect(
      settleRuleEmptiness(input({ liveness: dead, failOnEmpty: failsWhenEmpty({ severity: 'error', failOnEmpty: false }) }))
        .fails,
    ).toBe(false);
  });

  test('EMPTY_RULE_ADVICE is the DECISIONS wording; a failing rule is never told to set failOnEmpty: true', () => {
    expect(EMPTY_RULE_ADVICE).toBe(
      'Fix the selector — or, if its target does not exist yet, mark the unit { pattern, expectEmpty: true }',
    );
    const failing = formatEmptyRuleAdvice({ fails: true });
    const soft = formatEmptyRuleAdvice({ fails: false });
    expect(failing.startsWith(EMPTY_RULE_ADVICE)).toBe(true);
    expect(soft.startsWith(EMPTY_RULE_ADVICE)).toBe(true);
    expect(failing).not.toContain('failOnEmpty: true');
    expect(failing).toContain('failOnEmpty: false');
    expect(soft).toContain('failOnEmpty: true');
    expect(soft).not.toContain('failOnEmpty: false');
    // it takes the settled emptiness directly
    const settled = settleRuleEmptiness(input({ liveness: liveness([obs('x/**', false, false)]), failOnEmpty: true }));
    expect(formatEmptyRuleAdvice(settled)).toBe(failing);
  });
});
