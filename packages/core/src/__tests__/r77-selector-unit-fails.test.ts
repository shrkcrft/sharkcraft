/**
 * r77 — THE `--fail-on-dead-units` predicate (round 13, DECISIONS §2).
 *
 *   state                       | fails when
 *   ----------------------------+-------------------------------------------------------
 *   Dead                        | failOnDeadUnits
 *   WentLive, local marker      | failOnDeadUnits, or strict where strict promotes warnings
 *   WentLive, pack marker       | never (INFO — the consumer cannot edit it)
 *   IntendedEmpty/Live/Unproven | never
 *
 * Every consumer calls `selectorUnitFails`; the units here come from the real
 * settle, the pack provenance from the real stamp.
 */
import { describe, expect, test } from 'bun:test';
import {
  selectorUnitFails,
  settleUnitLiveness,
  settleVerdict,
  stampUnitMarks,
  UnitDeadWeight,
  UnitLivenessState,
  type ISelectorUnitFailOptions,
  type IUnitLiveness,
  type IUnitMark,
} from '../index.ts';

const PACK = '@scope/fence-pack';

function unitIn(state: UnitLivenessState, pack: boolean): IUnitLiveness {
  const [exists, live, marked] =
    state === UnitLivenessState.Live
      ? [true, true, false]
      : state === UnitLivenessState.Dead
        ? [false, false, false]
        : state === UnitLivenessState.IntendedEmpty
          ? [false, false, true]
          : state === UnitLivenessState.WentLive
            ? [true, true, true]
            : [undefined, undefined, true];
  const local: IUnitMark[] = marked ? [{ list: 'forbiddenImports', unit: 'u' }] : [];
  const s = settleUnitLiveness({
    unitLabel: 'forbidden patterns',
    weight: UnitDeadWeight.Advisory,
    observations: [{ list: 'forbiddenImports', unit: 'u', exists, live }],
    marks: pack ? stampUnitMarks(local, PACK) : local,
  });
  const u = s.units[0]!;
  expect(u.state).toBe(state);
  return u;
}

const FLAG_GRID: readonly ISelectorUnitFailOptions[] = [false, true].flatMap((failOnDeadUnits) =>
  [false, true].flatMap((strict) =>
    [false, true].map((strictPromotesWarnings) => ({ failOnDeadUnits, strict, strictPromotesWarnings })),
  ),
);

function expected(state: UnitLivenessState, pack: boolean, o: ISelectorUnitFailOptions): boolean {
  if (state === UnitLivenessState.Dead) return o.failOnDeadUnits;
  if (state === UnitLivenessState.WentLive) return !pack && (o.failOnDeadUnits || (o.strict && o.strictPromotesWarnings));
  return false;
}

describe('selectorUnitFails — the table, over every flag combination', () => {
  for (const state of Object.values(UnitLivenessState)) {
    for (const pack of [false, true]) {
      if (pack && (state === UnitLivenessState.Live || state === UnitLivenessState.Dead)) continue; // no marker to stamp
      test(`${state}${pack ? ' (pack marker)' : ''}`, () => {
        const u = unitIn(state, pack);
        for (const o of FLAG_GRID) expect({ ...o, fails: selectorUnitFails(u, o) }).toEqual({ ...o, fails: expected(state, pack, o) });
      });
    }
  }
});

describe('the cases the table exists for', () => {
  const ALL_ON: ISelectorUnitFailOptions = { failOnDeadUnits: true, strict: true, strictPromotesWarnings: true };

  test('an intended-empty unit never fails — not under --fail-on-dead-units, not under --strict', () => {
    expect(selectorUnitFails(unitIn(UnitLivenessState.IntendedEmpty, false), ALL_ON)).toBe(false);
  });

  test('a PACK marker that went live never fails the consumer, even with every flag on', () => {
    expect(selectorUnitFails(unitIn(UnitLivenessState.WentLive, true), ALL_ON)).toBe(false);
  });

  test('a LOCAL went-live marker fails under --strict only where --strict already promotes warnings (check boundaries)', () => {
    const u = unitIn(UnitLivenessState.WentLive, false);
    expect(selectorUnitFails(u, { failOnDeadUnits: false, strict: true, strictPromotesWarnings: true })).toBe(true);
    expect(selectorUnitFails(u, { failOnDeadUnits: false, strict: true, strictPromotesWarnings: false })).toBe(false);
    expect(selectorUnitFails(u, { failOnDeadUnits: true, strict: false, strictPromotesWarnings: false })).toBe(true);
  });

  test('a pack went-live marker over a Coverage target that contributes nothing still keeps its dead weight (2), though it never fails', () => {
    const s = settleUnitLiveness({
      subject: 'r',
      unitLabel: 'scope globs',
      weight: UnitDeadWeight.Coverage,
      observations: [{ list: 'from', unit: 'packages/plugin-react/**', exists: true, live: false }],
      marks: stampUnitMarks([{ list: 'from', unit: 'packages/plugin-react/**' }], PACK),
    });
    const u = s.units[0]!;
    expect(u.state).toBe(UnitLivenessState.WentLive);
    expect(selectorUnitFails(u, ALL_ON)).toBe(false);
    expect(settleVerdict(0, s.coverage).exit).toBe(2);
  });
});
