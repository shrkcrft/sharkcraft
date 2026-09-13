/**
 * r77 — the acceptance carrier on the shared gate envelope (round 13,
 * DECISIONS §3, J1 must-fix "give record B a carrier").
 *
 * `IGateRuleResult` holds ONE primary coverage record; an `expectEmpty`
 * acceptance (settle record B) rides beside it as `unitAcceptance`, and
 * `buildGateEnvelope` folds it into the ONE `settleVerdict` call — once, even
 * when the rule carries the same record as its coverage. Locked here: the
 * acceptance reaches `gate.accepted` only at exit 0; it never changes a rule's
 * status; a malformed carrier vetoes rather than vanishing; `rules[].units`
 * passes through; and the envelope gains NO always-present key.
 */
import { describe, expect, test } from 'bun:test';
import {
  RuleEmptiness,
  ruleAcceptedAsIntendedEmpty,
  ruleVerdictRecords,
  settleRuleEmptiness,
  settleUnitLiveness,
  UnitDeadWeight,
  unitStateLists,
  type ISettledUnitLiveness,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import { buildGateEnvelope, GATE_ENVELOPE_SCHEMA, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { ExitCode } from '../exit-codes.ts';

const RUN: IVerdictCoverage = { unit: 'rules', expected: 2, examined: 2 };
const ACCEPTED_LINE =
  'no-react-in-ui: accepted by expectEmpty: examined 0 of 1 globs, 1 asserted empty — matched 0 files: src/ui/**/*.ts';

/** A policy rule over one live glob and one planned (marked) glob — the real settle, not a hand-built record. */
function plannedUi(subject?: string): ISettledUnitLiveness {
  return settleUnitLiveness({
    ...(subject !== undefined ? { subject } : {}),
    unitLabel: 'globs',
    weight: UnitDeadWeight.Advisory,
    observations: [
      { list: 'files', unit: 'src/core/**/*.ts', exists: true, live: true },
      { list: 'files', unit: 'src/ui/**/*.ts', exists: false, live: false, deadReason: 'matched 0 files' },
    ],
    marks: [{ list: 'files', unit: 'src/ui/**/*.ts' }],
  });
}

function rule(over: Partial<IGateRuleResult> = {}): IGateRuleResult {
  return {
    id: 'no-react-in-ui',
    type: 'policy',
    status: 'passed',
    severity: 'error',
    counts: { units: 3, findings: 0 },
    violations: [],
    coverage: { unit: 'content units', expected: 3, examined: 3 },
    ...over,
  };
}

describe('buildGateEnvelope folds unitAcceptance into the one settleVerdict call', () => {
  test('at exit 0 the acceptance is printed in gate.accepted, prefixed with the rule id', () => {
    const s = plannedUi();
    const env = buildGateEnvelope(
      'policy-lint',
      ExitCode.VerifiedPass,
      [rule({ unitAcceptance: s.acceptance!, units: unitStateLists(s) }), rule({ id: 'other' })],
      RUN,
    );
    expect(env.exit).toBe(0);
    expect(env.verdict).toBe('pass');
    expect(env.shortfalls).toEqual([]);
    expect(env.accepted).toEqual([ACCEPTED_LINE]);
  });

  test('the acceptance is dropped from `accepted` at any other exit — never next to a 1 or a 2', () => {
    const s = plannedUi();
    const failed = buildGateEnvelope('policy-lint', ExitCode.Failure, [rule({ unitAcceptance: s.acceptance! })], RUN);
    expect(failed).toMatchObject({ exit: 1, accepted: [] });
    const partialSibling = buildGateEnvelope(
      'policy-lint',
      ExitCode.VerifiedPass,
      [
        rule({ unitAcceptance: s.acceptance! }),
        rule({ id: 'half', coverage: { unit: 'content units', expected: 2, examined: 1, reason: 'unread' } }),
      ],
      RUN,
    );
    expect(partialSibling).toMatchObject({ exit: 2, accepted: [] });
    expect(partialSibling.shortfalls).toEqual(['half: examined 1 of 2 content units, 1 unread']);
  });

  test('it never changes a rule\'s status: `partial` reads the primary record alone', () => {
    const s = plannedUi();
    const env = buildGateEnvelope(
      'policy-lint',
      ExitCode.VerifiedPass,
      [
        rule({ unitAcceptance: s.acceptance! }),
        rule({ id: 'half', unitAcceptance: s.acceptance!, coverage: { unit: 'files', expected: 2, examined: 1 } }),
      ],
      RUN,
    );
    expect(env.rules.map((r) => [r.id, r.status, r.shortfall])).toEqual([
      ['no-react-in-ui', 'passed', undefined],
      ['half', 'partial', 'examined 1 of 2 files, 1 not examined'],
    ]);
    expect(env.partial).toBe(1);
  });

  test('an IntendedEmpty rule carrying its acceptance as coverage AND as unitAcceptance is folded once', () => {
    const l = settleUnitLiveness({
      subject: 'no-react-in-ui',
      unitLabel: 'globs',
      weight: UnitDeadWeight.Advisory,
      observations: [{ list: 'files', unit: 'src/ui/**/*.ts', exists: false, live: false, deadReason: 'matched 0 files' }],
      marks: [{ list: 'files', unit: 'src/ui/**/*.ts' }],
    });
    const e = settleRuleEmptiness({
      subject: 'no-react-in-ui',
      unitLabel: 'content units',
      filesMatched: 0,
      unitsMatched: 0,
      unread: false,
      liveness: l,
      failOnEmpty: true,
      noFilesReason: '0 content units matched the rule globs',
      noUnitsReason: '0 content units matched the rule globs',
    });
    expect(e.coverage).toBe(l.acceptance);
    const identical = buildGateEnvelope(
      'policy-lint',
      ExitCode.VerifiedPass,
      [rule({ coverage: e.coverage!, unitAcceptance: l.acceptance! })],
      { unit: 'rules', expected: 1, examined: 1 },
    );
    expect(identical).toMatchObject({ exit: 0, accepted: [ACCEPTED_LINE] });
    expect(identical.rules[0]?.status).toBe('passed');
    // a structurally identical copy is the same claim — still one line
    const copied = buildGateEnvelope(
      'policy-lint',
      ExitCode.VerifiedPass,
      [rule({ coverage: { ...e.coverage! }, unitAcceptance: { ...l.acceptance! } })],
      { unit: 'rules', expected: 1, examined: 1 },
    );
    expect(copied.accepted).toEqual([ACCEPTED_LINE]);
  });

  test('a unitAcceptance with no subject gets the rule id, like the primary record', () => {
    const s = plannedUi(undefined);
    expect(s.acceptance?.subject).toBeUndefined();
    const env = buildGateEnvelope('gates check', ExitCode.VerifiedPass, [rule({ unitAcceptance: s.acceptance! })], RUN);
    expect(env.accepted).toEqual([ACCEPTED_LINE]);
  });

  test('a carrier that is not an acceptance (no acceptedBy) vetoes like any record — never silently dropped', () => {
    const env = buildGateEnvelope(
      'gates check',
      ExitCode.VerifiedPass,
      [rule({ unitAcceptance: { unit: 'globs', expected: 1, examined: 0 } })],
      RUN,
    );
    expect(env.exit).toBe(2);
    expect(env.shortfalls).toEqual(['no-react-in-ui: examined 0 of 1 globs, 1 not examined']);
    expect(env.rules[0]?.status).toBe('passed');
  });
});

describe('rules[].units and the envelope shape', () => {
  test('units pass through unchanged', () => {
    const s = plannedUi();
    const units = unitStateLists(s);
    const env = buildGateEnvelope('gates coverage', ExitCode.VerifiedPass, [rule({ unitAcceptance: s.acceptance!, units })], RUN);
    expect(env.rules[0]?.units).toEqual({
      dead: [],
      intendedEmpty: ['files: src/ui/**/*.ts — intended empty (expectEmpty) — matched 0 files'],
      wentLive: [],
    });
    expect(env.rules[0]?.unitAcceptance).toEqual(s.acceptance);
  });

  test('the envelope gains NO always-present key, and a rule without the new fields carries neither', () => {
    const env = buildGateEnvelope('gates check', ExitCode.VerifiedPass, [rule()], RUN);
    expect(Object.keys(env).sort()).toEqual([
      'accepted',
      'coverage',
      'evaluated',
      'exit',
      'failed',
      'partial',
      'rules',
      'schema',
      'shortfalls',
      'skipped',
      'verb',
      'verdict',
    ]);
    expect(env.schema).toBe(GATE_ENVELOPE_SCHEMA);
    const r = env.rules[0]!;
    expect('unitAcceptance' in r).toBe(false);
    expect('units' in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual(Object.keys(rule()).sort());
  });
});

describe('ruleVerdictRecords — the one fold the envelope and the boundary orchestrator share', () => {
  const primary: IVerdictCoverage = { unit: 'files', expected: 3, examined: 3 };
  const acceptance = plannedUi('r').acceptance!;

  test('primary alone, primary + acceptance, or one record when they are the same claim', () => {
    expect(ruleVerdictRecords(primary)).toEqual([primary]);
    expect(ruleVerdictRecords(primary, acceptance)).toEqual([primary, acceptance]);
    expect(ruleVerdictRecords(acceptance, acceptance)).toEqual([acceptance]);
    expect(ruleVerdictRecords(acceptance, { ...acceptance, subject: 'someone-else' })).toEqual([acceptance]);
    expect(ruleVerdictRecords(acceptance, { ...acceptance, unexamined: ['other'] })).toHaveLength(2);
  });
});

/**
 * K6 (round 13): a rule whose emptiness settled IntendedEmpty examined 0 files
 * by design — ACCEPTED, never evaluated. ONE predicate decides it
 * (`ruleAcceptedAsIntendedEmpty`, core, beside `ruleVerdictRecords`), reading
 * the PRIMARY record the settle put on the rule; the envelope's `evaluated`
 * leaves it out and the optional `acceptedEmpty` counts it.
 */
describe('K6 — an intended-empty rule is accepted, never evaluated', () => {
  /** The real settle of a rule whose only glob is planned: IntendedEmpty, its coverage IS the acceptance. */
  function intendedCoverage(): IVerdictCoverage {
    const l = settleUnitLiveness({
      subject: 'planned',
      unitLabel: 'globs',
      weight: UnitDeadWeight.Advisory,
      observations: [{ list: 'files', unit: 'src/ui/**/*.ts', exists: false, live: false, deadReason: 'matched 0 files' }],
      marks: [{ list: 'files', unit: 'src/ui/**/*.ts' }],
    });
    const e = settleRuleEmptiness({
      subject: 'planned',
      unitLabel: 'content units',
      filesMatched: 0,
      unitsMatched: 0,
      unread: false,
      liveness: l,
      failOnEmpty: true,
      noFilesReason: '0 content units matched the rule globs',
      noUnitsReason: '0 content units matched the rule globs',
    });
    expect(e.state).toBe(RuleEmptiness.IntendedEmpty);
    return e.coverage!;
  }

  test('the predicate reads the PRIMARY record: IntendedEmpty yes; a live rule with a planned sibling, the baselines fence, --allow-empty no', () => {
    expect(ruleAcceptedAsIntendedEmpty({ coverage: intendedCoverage() })).toBe(true);
    // Its acceptance rides beside a live primary record: it examined files.
    expect(ruleAcceptedAsIntendedEmpty(rule({ unitAcceptance: plannedUi().acceptance! }))).toBe(false);
    // The rule-level fence examined live inputs and asserts the OUTPUT is empty — a real comparison.
    const fence = settleRuleEmptiness({
      subject: 'fence',
      unitLabel: 'entries',
      filesMatched: 1,
      unitsMatched: 0,
      unread: false,
      liveness: settleUnitLiveness({
        unitLabel: 'globs',
        weight: UnitDeadWeight.Advisory,
        observations: [{ list: 'compute.source.files', unit: 'appA/**/*.ts', exists: true, live: true }],
        marks: [],
      }),
      assertsEmptyOutput: true,
      failOnEmpty: false,
      noFilesReason: 'x',
      noUnitsReason: 'x',
    });
    expect(fence.state).toBe(RuleEmptiness.AssertedEmptyOutput);
    expect(ruleAcceptedAsIntendedEmpty({ coverage: fence.coverage! })).toBe(false);
    expect(
      ruleAcceptedAsIntendedEmpty({ coverage: { unit: 'rules', expected: 0, examined: 0, acceptedBy: '--allow-empty' } }),
    ).toBe(false);
    expect(ruleAcceptedAsIntendedEmpty({})).toBe(false);
  });

  test('buildGateEnvelope: evaluated leaves it out, acceptedEmpty counts it — and the key exists only when non-zero', () => {
    const c = intendedCoverage();
    const mixed = buildGateEnvelope(
      'policy-lint',
      ExitCode.VerifiedPass,
      [rule({ id: 'planned', coverage: c, unitAcceptance: c }), rule({ id: 'live' })],
      RUN,
    );
    expect(mixed).toMatchObject({ exit: 0, evaluated: 1, acceptedEmpty: 1, skipped: 0, failed: 0, partial: 0 });
    expect(mixed.rules.map((r) => [r.id, r.status])).toEqual([
      ['planned', 'passed'],
      ['live', 'passed'],
    ]);
    const allAccepted = buildGateEnvelope('policy-lint', ExitCode.VerifiedPass, [rule({ id: 'planned', coverage: c })], {
      unit: 'rules',
      expected: 1,
      examined: 1,
    });
    expect(allAccepted).toMatchObject({ exit: 0, evaluated: 0, acceptedEmpty: 1 });
    // A rule that never ran (skipped / errored) is neither evaluated nor accepted.
    const notRun = buildGateEnvelope(
      'gates check',
      ExitCode.NotVerified,
      [rule({ id: 'planned', coverage: c, status: 'skipped' }), rule({ id: 'broken', coverage: c, status: 'error' })],
      RUN,
    );
    expect(notRun.evaluated).toBe(0);
    expect('acceptedEmpty' in notRun).toBe(false);
  });
});
