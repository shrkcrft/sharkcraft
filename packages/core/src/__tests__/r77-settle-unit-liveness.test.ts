/**
 * r77 — THE settle for selector units (round 13, DECISIONS §2).
 *
 * A reporter observes two facts per unit — raw existence (`exists`) and
 * effective contribution (`live`) — and `settleUnitLiveness` alone turns them,
 * plus the marker ledger, into a state, the printed sentence and the coverage
 * records. Locked here: the full truth table; record A only for the Coverage
 * weight and only over judged units; record B only when a unit is
 * intended-empty, labelled with what was OBSERVED; and, through the unchanged
 * core `settleVerdict`, that an acceptance shows only at exit 0, a Coverage
 * dead unit never settles 0, record B never accepts a dead unit, and a
 * went-live marker over a target that contributes nothing keeps its dead weight.
 */
import { describe, expect, test } from 'bun:test';
import {
  coverageShortfall,
  DEAD_SELECTOR_CAUSES,
  ExpectEmptyAcceptedBy,
  formatUnitLiveness,
  settleUnitLiveness,
  settleVerdict,
  stampUnitMarks,
  UnitDeadCause,
  UnitDeadWeight,
  UnitLivenessState,
  unitStateLists,
  type ISettledUnitLiveness,
  type IUnitLivenessInput,
  type IUnitMark,
  type IUnitObservation,
} from '../index.ts';

const TRI: readonly (boolean | undefined)[] = [true, false, undefined];

function mark(unit: string, extra: Partial<IUnitMark> = {}, list = 'files'): IUnitMark {
  return { list, unit, ...extra };
}

function obs(
  unit: string,
  exists: boolean | undefined,
  live: boolean | undefined,
  extra: Partial<IUnitObservation> = {},
): IUnitObservation {
  return { list: 'files', unit, exists, live, ...extra };
}

function settle(
  observations: readonly IUnitObservation[],
  marks: readonly IUnitMark[] = [],
  extra: Partial<IUnitLivenessInput> = {},
): ISettledUnitLiveness {
  return settleUnitLiveness({
    subject: 'r',
    unitLabel: 'scope globs',
    weight: UnitDeadWeight.Coverage,
    observations,
    marks,
    ...extra,
  });
}

function expectedState(marked: boolean, exists: boolean | undefined, live: boolean | undefined): UnitLivenessState {
  if (!marked) {
    return live === undefined ? UnitLivenessState.Unproven : live ? UnitLivenessState.Live : UnitLivenessState.Dead;
  }
  return exists === undefined
    ? UnitLivenessState.Unproven
    : exists
      ? UnitLivenessState.WentLive
      : UnitLivenessState.IntendedEmpty;
}

describe('the truth table', () => {
  test('marked? × exists × live → state, every one of the 18 rows', () => {
    const rows: string[] = [];
    for (const marked of [false, true]) {
      for (const exists of TRI) {
        for (const live of TRI) {
          const s = settle([obs('u', exists, live)], marked ? [mark('u')] : []);
          const got = s.units[0]?.state;
          const want = expectedState(marked, exists, live);
          rows.push(`${marked}/${String(exists)}/${String(live)} → ${String(got)}`);
          expect({ marked, exists, live, state: got }).toEqual({ marked, exists, live, state: want });
          expect(s.units[0]?.marked).toBe(marked);
        }
      }
    }
    expect(rows).toHaveLength(18);
  });

  test('the state lists partition the units, in input order', () => {
    const s = settle(
      [obs('live', true, true), obs('dead', false, false), obs('ie', false, false), obs('wl', true, true), obs('up', undefined, undefined)],
      [mark('ie'), mark('wl')],
    );
    expect(s.units.map((u) => u.unit)).toEqual(['live', 'dead', 'ie', 'wl', 'up']);
    expect(s.live.map((u) => u.unit)).toEqual(['live']);
    expect(s.dead.map((u) => u.unit)).toEqual(['dead']);
    expect(s.intendedEmpty.map((u) => u.unit)).toEqual(['ie']);
    expect(s.wentLive.map((u) => u.unit)).toEqual(['wl']);
    expect(s.unproven.map((u) => u.unit)).toEqual(['up']);
  });

  test('effective: Live, or WentLive whose live is true — never a went-live unit that contributes nothing', () => {
    const s = settle(
      [obs('l', true, true), obs('wl-eff', true, true), obs('wl-dead', true, false), obs('wl-up', true, undefined)],
      [mark('wl-eff'), mark('wl-dead'), mark('wl-up')],
    );
    expect(s.units.map((u) => [u.unit, u.effective])).toEqual([
      ['l', true],
      ['wl-eff', true],
      ['wl-dead', false],
      ['wl-up', false],
    ]);
  });

  test('a unit dead by SHAPE is Dead whatever the ledger says — its marker is ignored, and said so', () => {
    const s = settle(
      [obs('@scope/pkg/', false, false, { cause: UnitDeadCause.Defect, deadReason: "a trailing '/' matches only …" })],
      [mark('@scope/pkg/')],
    );
    const u = s.units[0]!;
    expect(u.state).toBe(UnitLivenessState.Dead);
    expect(u.marked).toBe(false);
    expect(u.mark).toEqual(mark('@scope/pkg/'));
    expect(u.message).toContain('its expectEmpty marker is ignored: a defect unit is dead by its shape');
    expect(s.intendedEmpty).toEqual([]);
  });

  test('a mark whose (list, unit) no reporter observed is surfaced, never silently dropped', () => {
    const s = settle([obs('a', true, true)], [mark('a'), mark('never-observed'), mark('a', {}, 'to.files')]);
    expect(s.unobservedMarks).toEqual([mark('never-observed'), mark('a', {}, 'to.files')]);
  });
});

describe('record A — the dead shortfall', () => {
  test('ONLY for the Coverage weight: an Advisory settle emits no record A, whatever is dead', () => {
    const s = settle([obs('a', false, false), obs('b', true, true)], [], { weight: UnitDeadWeight.Advisory });
    expect(s.dead).toHaveLength(1);
    expect(s.shortfall).toBeUndefined();
    expect(s.coverage).toEqual([]);
  });

  test('over the JUDGED Coverage units: examined = effective; Dead / Unproven / not-effective WentLive are the gap', () => {
    const s = settle(
      [
        obs('live/**', true, true),
        obs('dead/**', false, false),
        obs('planned/**', false, false),
        obs('went-exempt/**', true, false),
        obs('unread/**', undefined, undefined),
      ],
      [mark('planned/**'), mark('went-exempt/**')],
      { deadSummary: 'reached no governed file among 4 scanned' },
    );
    expect(s.shortfall).toEqual({
      subject: 'r',
      unit: 'scope globs',
      expected: 4,
      examined: 1,
      unexamined: ['dead/**', 'went-exempt/**', 'unread/** (unproven)'],
      unexaminedTotal: 3,
      reason: 'reached no governed file among 4 scanned',
    });
  });

  test('ONLY when at least one Coverage unit is judged — an all-intended-empty list never yields an unsuppressed expected-0 record', () => {
    const s = settle([obs('planned/**', false, false)], [mark('planned/**')]);
    expect(s.shortfall).toBeUndefined();
    expect(s.coverage).toEqual([s.acceptance!]);
    // …which is exactly the record that would have settled 2 ('0 scope globs to examine').
    expect(coverageShortfall({ unit: 'scope globs', expected: 0, examined: 0 })).toBeDefined();
    expect(settleVerdict(0, s.coverage).exit).toBe(0);
  });

  test('no gap → a clean record with no reason and no labels (the shape a full boundary scope has today)', () => {
    expect(settle([obs('a', true, true), obs('b', true, true)]).shortfall).toEqual({
      subject: 'r',
      unit: 'scope globs',
      expected: 2,
      examined: 2,
    });
  });

  test('an observation may override the settle weight — one settle serves the boundary from list (Coverage) and its exemptions (Advisory)', () => {
    const s = settle([
      obs('packages/app/**', true, true),
      obs('!packages/app/**/*.stories.tsx', false, false, { weight: UnitDeadWeight.Advisory }),
    ]);
    expect(s.shortfall).toEqual({ subject: 'r', unit: 'scope globs', expected: 1, examined: 1 });
    expect(s.dead.map((u) => u.unit)).toEqual(['!packages/app/**/*.stories.tsx']);
  });

  test('a capped scan is always a capped record — never clean, never acceptable — even with nothing judged', () => {
    const s = settle([obs('planned/**', false, false)], [mark('planned/**')], {
      capped: true,
      cappedReason: 'a discovery walk hit its 5000-directory cap',
    });
    expect(s.shortfall).toEqual({
      subject: 'r',
      unit: 'scope globs',
      expected: 0,
      examined: 0,
      capped: true,
      reason: 'a discovery walk hit its 5000-directory cap',
    });
    expect(settleVerdict(0, s.coverage)).toMatchObject({ exit: 2, accepted: [] });
  });
});

describe('record B — the acceptance', () => {
  test('emitted ONLY when a unit is intended-empty, whatever its weight', () => {
    expect(settle([obs('a', false, false)]).acceptance).toBeUndefined();
    expect(settle([obs('a', true, true)], [mark('a')]).acceptance).toBeUndefined(); // went live: no acceptance
    const advisory = settle([obs('@scope/plugin-react', false, false)], [mark('@scope/plugin-react')], {
      weight: UnitDeadWeight.Advisory,
      unitLabel: 'forbidden patterns',
    });
    expect(advisory.acceptance?.acceptedBy).toBe(ExpectEmptyAcceptedBy.Unit);
  });

  test('its exact shape: expected n, examined 0, the labels, the OBSERVED reason, acceptedBy expectEmpty', () => {
    const observed =
      'matches no import anywhere in the repo, no workspace/dependency package name, no tsconfig alias and no file';
    const s = settle(
      [obs('@scope/plugin-react', false, false, { deadReason: observed }), obs('@scope/kernel', false, false, { deadReason: observed })],
      [mark('@scope/plugin-react'), mark('@scope/kernel', { reason: 'layer root' })],
      { weight: UnitDeadWeight.Advisory, unitLabel: 'forbidden patterns' },
    );
    expect(s.acceptance).toEqual({
      subject: 'r',
      unit: 'forbidden patterns',
      expected: 2,
      examined: 0,
      unexamined: ['@scope/plugin-react', '@scope/kernel'],
      unexaminedTotal: 2,
      reason: `asserted empty — ${observed}`,
      acceptedBy: 'expectEmpty',
    });
  });

  test('labels carry each unit\'s observed reason when they differ — never a constant "does not exist yet"', () => {
    const s = settle(
      [
        obs('packages/plugin-react/**', false, false, { list: 'from', deadReason: 'matched 0 of 4 scanned files' }),
        obs('@scope/plugin-react', false, false, { list: 'forbiddenImports', deadReason: 'matches no import anywhere' }),
      ],
      [mark('packages/plugin-react/**', {}, 'from'), mark('@scope/plugin-react', {}, 'forbiddenImports')],
      { acceptanceUnitLabel: 'selector units' },
    );
    expect(s.acceptance).toMatchObject({
      unit: 'selector units',
      reason: 'asserted empty',
      unexamined: [
        'from: packages/plugin-react/** (matched 0 of 4 scanned files)',
        'forbiddenImports: @scope/plugin-react (matches no import anywhere)',
      ],
    });
    expect(JSON.stringify(s.acceptance)).not.toContain('does not exist yet');
  });

  test('a custom label is used verbatim (an asset doctor names `<hint>: <glob>`)', () => {
    const s = settle(
      [obs('src/plugins/**/registry.ts', false, false, { label: 'fx.plugin-registry: src/plugins/**/registry.ts' })],
      [mark('src/plugins/**/registry.ts')],
    );
    expect(s.acceptance?.unexamined).toEqual(['fx.plugin-registry: src/plugins/**/registry.ts']);
  });
});

describe('through core settleVerdict (unchanged)', () => {
  const planned = obs('packages/plugin-react/**', false, false, { deadReason: 'matched 0 of 4 scanned files' });

  test('an acceptance appears in `accepted` ONLY at exit 0', () => {
    const s = settle([obs('packages/app/**', true, true), planned], [mark('packages/plugin-react/**')]);
    expect(settleVerdict(0, s.coverage)).toEqual({
      exit: 0,
      verdict: 'pass',
      shortfalls: [],
      accepted: [
        'r: accepted by expectEmpty: examined 0 of 1 scope globs, 1 asserted empty — matched 0 of 4 scanned files: packages/plugin-react/**',
      ],
    });
    expect(settleVerdict(1, s.coverage)).toMatchObject({ exit: 1, accepted: [] });
    expect(settleVerdict(2, s.coverage)).toMatchObject({ exit: 2, accepted: [] });
  });

  test('a Coverage-weight dead unit never settles 0 — and a sibling acceptance does not rescue it', () => {
    const s = settle(
      [obs('packages/app/**', true, true), obs('packages/typo/**', false, false), planned],
      [mark('packages/plugin-react/**')],
    );
    const v = settleVerdict(0, s.coverage);
    expect(v.exit).toBe(2);
    expect(v.shortfalls).toEqual(['r: examined 1 of 2 scope globs, 1 matched nothing: packages/typo/**']);
    expect(v.accepted).toEqual([]);
  });

  test('record B never accepts a dead unit: its labels are the intended-empty units only', () => {
    const s = settle(
      [obs('dead/**', false, false), planned, obs('went/**', true, false)],
      [mark('packages/plugin-react/**'), mark('went/**')],
    );
    expect(s.acceptance?.unexamined).toEqual(['packages/plugin-react/**']);
    expect(s.shortfall?.unexamined).toEqual(['dead/**', 'went/**']);
  });

  test('a WentLive unit that is NOT effective keeps its dead weight: never 2 → 0', () => {
    // The target exists (raw match) but contributes nothing (every file exempt).
    const went = obs('packages/plugin-react/**', true, false, {
      deadReason: 'matches only exempt files (1)',
      liveBecause: '1 scanned file matches it',
    });
    const unmarked = settleVerdict(0, settle([went]).coverage);
    const marked = settleVerdict(0, settle([went], [mark('packages/plugin-react/**')]).coverage);
    expect(unmarked.exit).toBe(2);
    expect(marked.exit).toBe(2);
    expect(marked.accepted).toEqual([]);
    const u = settle([went], [mark('packages/plugin-react/**')]).units[0]!;
    expect(u.state).toBe(UnitLivenessState.WentLive);
    expect(u.message).toBe(
      'expectEmpty is stale: 1 scanned file matches it — the fence went live; remove expectEmpty; it still contributes nothing (matches only exempt files (1))',
    );
  });

  test('property: over every pair of units (marked × exists × live × weight), the records and the exit follow the rules', () => {
    type Cell = { marked: boolean; exists: boolean | undefined; live: boolean | undefined; weight: UnitDeadWeight };
    const cells: Cell[] = [];
    for (const marked of [false, true])
      for (const exists of TRI)
        for (const live of TRI)
          for (const weight of [UnitDeadWeight.Advisory, UnitDeadWeight.Coverage]) cells.push({ marked, exists, live, weight });
    let checked = 0;
    for (const a of cells) {
      for (const b of cells) {
        const pair = [a, b];
        const s = settle(
          pair.map((c, i) => obs(`u${i}`, c.exists, c.live, { weight: c.weight })),
          pair.flatMap((c, i) => (c.marked ? [mark(`u${i}`)] : [])),
        );
        const coverageJudged = s.units.filter(
          (u) => u.weight === UnitDeadWeight.Coverage && u.state !== UnitLivenessState.IntendedEmpty,
        );
        const gap = coverageJudged.filter((u) => !u.effective);
        // record A exists iff a Coverage unit is judged; it counts exactly the effective ones
        expect(s.shortfall !== undefined).toBe(coverageJudged.length > 0);
        if (s.shortfall) {
          expect(s.shortfall.expected).toBe(coverageJudged.length);
          expect(s.shortfall.examined).toBe(coverageJudged.length - gap.length);
        }
        // record B exists iff a unit is intended-empty, and names exactly those
        expect(s.acceptance !== undefined).toBe(s.intendedEmpty.length > 0);
        if (s.acceptance) {
          expect(s.acceptance.examined).toBe(0);
          expect(s.acceptance.expected).toBe(s.intendedEmpty.length);
          expect(s.acceptance.unexamined).toEqual(s.intendedEmpty.map((u) => u.label));
        }
        // the exit: 0 iff no Coverage gap; an acceptance is printed iff 0 and something is intended-empty
        const v = settleVerdict(0, s.coverage);
        expect(v.exit).toBe(gap.length > 0 ? 2 : 0);
        expect(v.accepted.length > 0).toBe(v.exit === 0 && s.intendedEmpty.length > 0);
        checked += 1;
      }
    }
    expect(checked).toBe(36 * 36);
  });
});

describe('the one per-unit line', () => {
  const noReach =
    'matches no import anywhere in the repo, no workspace/dependency package name, no tsconfig alias and no file';

  test('DEAD_SELECTOR_CAUSES is the 13.1 wording, verbatim', () => {
    expect(DEAD_SELECTOR_CAUSES).toBe('typo, retired target, or a target that does not exist yet (see expectEmpty)');
  });

  test('dead: the observed reason, then the causes — unless the unit is dead by shape, or the surface prints a footer', () => {
    const s = settle([obs('@scope/plugin-react', false, false, { deadReason: noReach })]);
    expect(formatUnitLiveness(s.units[0]!)).toBe(`@scope/plugin-react — ${noReach} — ${DEAD_SELECTOR_CAUSES}`);
    expect(formatUnitLiveness(s.units[0]!, { causes: false })).toBe(`@scope/plugin-react — ${noReach}`);
    const shape = settle([obs('@scope/pkg/', false, false, { cause: UnitDeadCause.Defect, deadReason: 'a defect' })]);
    expect(formatUnitLiveness(shape.units[0]!)).toBe('@scope/pkg/ — a defect');
  });

  test('intended-empty, went-live and a pack marker', () => {
    const s = settle(
      [
        obs('@scope/plugin-react', false, false, { list: 'forbiddenImports', deadReason: noReach }),
        obs('@scope/kernel', true, true, { list: 'forbiddenImports', liveBecause: '2 import(s)' }),
        obs('@scope/ui', true, true, { list: 'forbiddenImports', liveBecause: 'a workspace package now names it' }),
      ],
      [
        mark('@scope/plugin-react', { reason: 'planned binding' }, 'forbiddenImports'),
        mark('@scope/kernel', {}, 'forbiddenImports'),
        ...stampUnitMarks([mark('@scope/ui', {}, 'forbiddenImports')], '@scope/fence-pack'),
      ],
      { weight: UnitDeadWeight.Advisory, unitLabel: 'forbidden patterns' },
    );
    const [ie, wl, pack] = s.units;
    expect(formatUnitLiveness(ie!)).toBe(`@scope/plugin-react — intended empty (expectEmpty: planned binding) — ${noReach}`);
    expect(formatUnitLiveness(wl!)).toBe(
      '@scope/kernel — expectEmpty is stale: 2 import(s) — the fence went live; remove expectEmpty',
    );
    expect(formatUnitLiveness(pack!)).toBe(
      '@scope/ui — expectEmpty is stale: a workspace package now names it — the fence went live; remove expectEmpty [marker from pack @scope/fence-pack: reported as INFO, never fails]',
    );
    expect(formatUnitLiveness(ie!, { list: true })).toStartWith('forbiddenImports: @scope/plugin-react — ');
  });

  test('the list prefix is never doubled onto a qualified label', () => {
    const s = settle(
      [obs('a/**', false, false, { list: 'declared.files' }), obs('b/**', false, false, { list: 'registered.files' })],
      [],
      { weight: UnitDeadWeight.Advisory },
    );
    expect(formatUnitLiveness(s.units[0]!, { list: true, causes: false })).toBe('declared.files: a/** — matches nothing');
  });

  test('unitStateLists: the rules[].units lines, list-qualified, causes left to the footer', () => {
    const s = settle(
      [obs('dead/**', false, false), obs('planned/**', false, false), obs('went/**', true, true, { liveBecause: 'now matches 3 files' })],
      [mark('planned/**'), mark('went/**')],
      { weight: UnitDeadWeight.Advisory },
    );
    expect(unitStateLists(s)).toEqual({
      dead: ['files: dead/** — matches nothing'],
      intendedEmpty: ['files: planned/** — intended empty (expectEmpty) — nothing matches it yet'],
      wentLive: ['files: went/** — expectEmpty is stale: now matches 3 files — the fence went live; remove expectEmpty'],
    });
  });
});
