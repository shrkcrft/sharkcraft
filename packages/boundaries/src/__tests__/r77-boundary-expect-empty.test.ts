/**
 * r77 — boundary rules take per-pattern `expectEmpty` (round 13, spec 13.1;
 * DECISIONS §1–§4; DESIGN-D1 tests item 4).
 *
 *   - the spec's exact syntax loads through the REAL loader
 *     (`loadBoundaryRulesFromFile`): the lists stay plain strings, the marker
 *     joins the `expectEmptyUnits` ledger, and a pack loader stamps its name;
 *   - every refusal: a malformed marker (core's words, `<list>[i]: …`), a
 *     rule-level `expectEmpty` / `allowDead` / `intendedEmpty`, any unknown key
 *     (did-you-mean), a marker on a defective / redundant / shadowed pattern,
 *     an object `exceptions[].target`, `failOnEmpty: true` over an all-marked
 *     `from`;
 *   - a HAND-BUILT object-form rule handed straight to `evaluateBoundaries` is
 *     honoured — never the `pattern.includes is not a function` crash (V1-U7);
 *   - went live per signal: a package name, a dependency (both the evaluator's
 *     known-package seam), a tsconfig alias (the real loader), a file, the
 *     `@scope/kernel` layer root, a `from` glob, an exemption.
 *
 * Real temp trees and the real scanner; no invented shapes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEAD_SELECTOR_CAUSES,
  ruleVerdictRecords,
  selectorUnitFails,
  settleVerdict,
  UnitLivenessState,
} from '@shrkcrft/core';
import { evaluateBoundaries, type IBoundaryRuleCoverage, type IEvaluateOptions } from '../evaluate/evaluate-boundaries.ts';
import { validateBoundaryRule, type IBoundaryRule } from '../model/boundary-rule.ts';
import { normalizeBoundaryRule } from '../model/normalize-boundary-rule.ts';
import { loadBoundaryRulesFromFile } from '../registry/load-boundary-rules.ts';
import { LEADING_WILDCARD_NEVER_DEAD, RELATIVE_PATTERN_NEVER_DEAD } from '../scan/import-pattern.ts';
import { nodeBuiltinPackageNames } from '../scan/node-builtin-package-names.ts';
import { scanImports } from '../scan/scan-imports.ts';
import { loadTsconfigPaths } from '../scan/tsconfig-aliases.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-boundary-ee-'));
  roots.push(root);
  const all: Record<string, string> = { 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }), ...files };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** Load a rule file's default export through THE boundary loader. */
async function load(rulesSource: string, packageName?: string) {
  const root = tree({ 'rules.ts': `export default ${rulesSource};\n` });
  return loadBoundaryRulesFromFile(join(root, 'rules.ts'), packageName !== undefined ? { packageName } : {});
}

/** Scan a real tree and evaluate rules over it. */
function evaluate(files: Readonly<Record<string, string>>, rules: readonly IBoundaryRule[], options: IEvaluateOptions = {}) {
  const root = tree(files);
  const scan = scanImports({ projectRoot: root });
  return { root, result: evaluateBoundaries(scan, rules, options) };
}

function unit(c: IBoundaryRuleCoverage, list: string, u: string) {
  const found = (c.unitLiveness ?? []).find((x) => x.list === list && x.unit === u);
  if (found === undefined) throw new Error(`no settled unit ${list} ${u}`);
  return found;
}

const issuesOf = (v: unknown): string[] => validateBoundaryRule(v).issues.map((i) => `${i.field}: ${i.message}`);

const BASE = { id: 'r', title: 'r', from: ['src/**'] };

describe('the spec syntax loads through the real loader', () => {
  test("forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }] — plain lists + a ledger", async () => {
    const loaded = await load(`[{ id: 'layer.no-imports-up', title: 'no imports up', from: ['packages/app/**'],
      forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }, '@scope/kernel'] }]`);
    expect(loaded.invalid).toEqual([]);
    expect(loaded.rules).toHaveLength(1);
    const rule = loaded.rules[0]!;
    expect(rule.forbiddenImports).toEqual(['@scope/kernel-*', '@scope/plugin-react', '@scope/kernel']);
    expect(rule.expectEmptyUnits).toEqual([{ list: 'forbiddenImports', unit: '@scope/plugin-react' }]);
  });

  test('markers on every markable list, a negation keeping its "!", a reason — and a pack loader stamps its name', async () => {
    const loaded = await load(
      `[{ id: 'r', title: 'r',
        from: ['src/**', { pattern: 'plugins/**', expectEmpty: true, reason: 'ADR-7' }, { pattern: '!src/**/*.gen.ts', expectEmpty: true }],
        exemptFiles: [{ pattern: 'src/generated/**', expectEmpty: true }],
        allowedImports: ['@scope/util', { pattern: '@scope/future-sdk', expectEmpty: true }] }]`,
      '@r13/fence-pack',
    );
    expect(loaded.invalid).toEqual([]);
    const rule = loaded.rules[0]!;
    expect(rule.from).toEqual(['src/**', 'plugins/**', '!src/**/*.gen.ts']);
    expect(rule.exemptFiles).toEqual(['src/generated/**']);
    expect(rule.allowedImports).toEqual(['@scope/util', '@scope/future-sdk']);
    expect(rule.expectEmptyUnits).toEqual([
      { list: 'from', unit: 'plugins/**', reason: 'ADR-7', packageName: '@r13/fence-pack' },
      { list: 'from', unit: '!src/**/*.gen.ts', packageName: '@r13/fence-pack' },
      { list: 'exemptFiles', unit: 'src/generated/**', packageName: '@r13/fence-pack' },
      { list: 'allowedImports', unit: '@scope/future-sdk', packageName: '@r13/fence-pack' },
    ]);
  });

  test('normalisation is idempotent: a loaded rule comes back as the same object', async () => {
    const loaded = await load(`[{ id: 'r', title: 'r', from: ['src/**'], forbiddenImports: [{ pattern: '@x/y', expectEmpty: true }] }]`);
    const rule = loaded.rules[0]!;
    const again = normalizeBoundaryRule(rule);
    expect(again.ok && again.value).toBe(rule);
  });
});

describe('every refusal', () => {
  test('a rule-level expectEmpty / allowDead / intendedEmpty (and the derived ledger) — the marker is per pattern', () => {
    const perPattern = 'expectEmpty is per pattern on a boundary rule: forbiddenImports: [{ pattern, expectEmpty: true }]';
    for (const key of ['expectEmpty', 'allowDead', 'intendedEmpty', 'expectEmptyUnits']) {
      expect(issuesOf({ ...BASE, forbiddenImports: ['x'], [key]: true })).toEqual([`${key}: ${perPattern}`]);
    }
  });

  test('any unknown key is refused, with a did-you-mean through the one scorer', () => {
    expect(issuesOf({ ...BASE, forbiddenImports: ['x'], sevrity: 'error' })).toEqual([
      "sevrity: unknown key 'sevrity' — not a boundary rule field, so it would be silently ignored; did you mean 'severity'?",
    ]);
    expect(issuesOf({ ...BASE, forbiddenImports: ['x'], zzqqxx: 1 })).toEqual([
      "zzqqxx: unknown key 'zzqqxx' — not a boundary rule field, so it would be silently ignored",
    ]);
  });

  test("a malformed marker — core's words, named per entry", () => {
    expect(issuesOf({ ...BASE, forbiddenImports: ['x', { pattern: 'y' }] })).toEqual([
      'forbiddenImports[1]: an object entry must set expectEmpty: true — write the plain string otherwise',
    ]);
    expect(issuesOf({ ...BASE, forbiddenImports: [{ expectEmpty: true }] })).toEqual([
      "forbiddenImports[0]: a marker naming no unit — write { pattern: '<glob or specifier>', expectEmpty: true }",
    ]);
    expect(issuesOf({ ...BASE, forbiddenImports: [42] })).toEqual([
      'forbiddenImports[0]: must be a string or { pattern, expectEmpty: true, reason? } (got 42)',
    ]);
    expect(
      issuesOf({
        ...BASE,
        forbiddenImports: [{ pattern: 'y', expectEmpty: true }, { pattern: 'y', expectEmpty: true }],
      }),
    ).toEqual(["forbiddenImports[1]: 'y' is already marked expectEmpty at forbiddenImports[0] — mark a unit once"]);
    // A plain duplicate stays legal.
    expect(issuesOf({ ...BASE, forbiddenImports: ['y', 'y'] })).toEqual([]);
  });

  test("{ pattern: '!' } in from is refused exactly like '!'", () => {
    expect(issuesOf({ ...BASE, from: ['src/**', { pattern: '!', expectEmpty: true }], forbiddenImports: ['x'] })).toEqual(
      issuesOf({ ...BASE, from: ['src/**', '!'], forbiddenImports: ['x'] }),
    );
  });

  test('a marker on a defective, a redundant or a shadowed pattern — dead by shape, it can never go live', () => {
    const defect = issuesOf({ ...BASE, forbiddenImports: [{ pattern: '@scope/pkg/', expectEmpty: true }] });
    expect(defect.some((i) => i.startsWith("forbiddenImports[0]: '@scope/pkg/': "))).toBe(true);
    expect(defect).toContain(
      "forbiddenImports[0]: '@scope/pkg/' is marked expectEmpty, but a defective pattern can never go live — fix the pattern; a marker cannot waive a defect",
    );
    expect(issuesOf({ ...BASE, forbiddenImports: ['@scope/plugin-*', { pattern: '@scope/plugin-react', expectEmpty: true }] })).toEqual([
      "forbiddenImports[1]: '@scope/plugin-react' is marked expectEmpty, but '@scope/plugin-*' already covers every import it could match — a redundant pattern can never decide a verdict, so it can never go live; delete it",
    ]);
    expect(
      issuesOf({ ...BASE, forbiddenImports: ['@scope/pkg'], allowedImports: [{ pattern: '@scope/pkg/public/**', expectEmpty: true }] }),
    ).toEqual([
      "allowedImports[0]: '@scope/pkg/public/**' is marked expectEmpty, but forbidden '@scope/pkg' is checked first and covers it — it can never admit an import, so it can never go live; carve the subpath out with exceptions[{ path, target, reason }] or set forbiddenMatch: 'exact'",
    ]);
  });

  test('an object exceptions[].target — a stale exception is an error by design', () => {
    expect(
      issuesOf({
        ...BASE,
        forbiddenImports: ['@scope/kernel-*'],
        exceptions: [{ path: 'src/bridge.ts', target: { pattern: '@scope/kernel-a', expectEmpty: true }, reason: 'ADR-1' }],
      }),
    ).toEqual(['exceptions[0].target: exceptions take no expectEmpty — a stale exception is an error by design']);
  });

  test('failOnEmpty: true with EVERY from inclusion marked is refused; partial marking and the default are legal', () => {
    const allMarked = { ...BASE, from: [{ pattern: 'plugins/**', expectEmpty: true }], forbiddenImports: ['x'] };
    expect(issuesOf({ ...allMarked, failOnEmpty: true })).toEqual([
      "failOnEmpty: every inclusion unit of `from` is asserted empty (expectEmpty), so the rule's empty result is intended — failOnEmpty: true asserts the opposite; drop one of them",
    ]);
    expect(issuesOf(allMarked)).toEqual([]);
    expect(issuesOf({ ...allMarked, from: ['src/**', { pattern: 'plugins/**', expectEmpty: true }], failOnEmpty: true })).toEqual([]);
  });

  test('a marker on a pattern the dead-unit judge can never call dead — relative, leading *, a runtime builtin — could only read went-live: refused (K5)', async () => {
    const tail = ' — a marker on it could only ever read went-live; write the plain pattern (it needs no expectEmpty)';
    expect(
      issuesOf({
        ...BASE,
        forbiddenImports: [
          { pattern: '*-legacy', expectEmpty: true },
          { pattern: '../legacy/**', expectEmpty: true },
          { pattern: 'fs', expectEmpty: true },
          { pattern: '@scope/plugin-react', expectEmpty: true },
        ],
        allowedImports: [{ pattern: './local/**', expectEmpty: true }],
      }),
    ).toEqual([
      `forbiddenImports[0]: '*-legacy' is marked expectEmpty, but ${LEADING_WILDCARD_NEVER_DEAD}${tail}`,
      `forbiddenImports[1]: '../legacy/**' is marked expectEmpty, but ${RELATIVE_PATTERN_NEVER_DEAD}${tail}`,
      `forbiddenImports[2]: 'fs' is marked expectEmpty, but 'fs' is a runtime builtin module — always a known package — so it always resolves and is never judged dead${tail}`,
      `allowedImports[0]: './local/**' is marked expectEmpty, but ${RELATIVE_PATTERN_NEVER_DEAD}${tail}`,
    ]);
    // The plain spellings load — each needs no marker.
    expect(issuesOf({ ...BASE, forbiddenImports: ['*-legacy', '../legacy/**', 'fs'], allowedImports: ['./local/**'] })).toEqual([]);
    // The judge agrees: over the builtins the orchestrator always supplies, none
    // of them is ever dead — so a marker could never have read intended-empty.
    const files = { 'packages/app/src/x.ts': "import { u } from '@scope/util';\nexport const x = u;\n" };
    const plain = evaluate(
      files,
      [{ id: 'p', title: 'p', from: ['packages/app/**'], forbiddenImports: ['*-legacy', '../legacy/**', 'fs'] }],
      { knownPackages: nodeBuiltinPackageNames() },
    ).result.coverage[0]!;
    expect(plain.forbidden.map((f) => [f.pattern, f.resolvable])).toEqual([
      ['*-legacy', true],
      ['../legacy/**', true],
      ['fs', true],
    ]);
    expect(plain.deadUnits).toEqual([]);
    // Through THE loader: an invalid rule, named per entry.
    const loaded = await load(`[{ id: 'rel', title: 'rel', from: ['src/**'], forbiddenImports: [{ pattern: '../legacy/**', expectEmpty: true }] }]`);
    expect(loaded.rules).toEqual([]);
    expect(loaded.invalid.map((i) => [i.ruleId, i.issues.map((x) => x.field)])).toEqual([['rel', ['forbiddenImports[0]']]]);
  });

  test('the loader turns every refusal into an invalid rule — never loaded, never silently ignored', async () => {
    const loaded = await load(`[
      { id: 'ok', title: 'ok', from: ['src/**'], forbiddenImports: [{ pattern: '@x/y', expectEmpty: true }] },
      { id: 'rule-level', title: 'bad', from: ['src/**'], forbiddenImports: ['@x/z'], expectEmpty: true },
      { id: 'bad-marker', title: 'bad', from: ['src/**'], forbiddenImports: [{ pattern: '@x/z', expectEmpty: false }] },
    ]`);
    expect(loaded.rules.map((r) => r.id)).toEqual(['ok']);
    expect(loaded.invalid.map((i) => [i.ruleId, i.issues.map((x) => x.field)])).toEqual([
      ['rule-level', ['expectEmpty']],
      ['bad-marker', ['forbiddenImports[0]']],
    ]);
  });
});

describe('a hand-built object-form rule is honoured by the engine, never a crash (V1-U7)', () => {
  const files = { 'packages/app/src/x.ts': "import { u } from '@scope/util';\nexport const x = u;\n" };

  test('the marker is honoured: intended-empty, accepted, no dead unit', () => {
    const rule = {
      id: 'layer.no-imports-up',
      title: 'no imports up',
      from: ['packages/app/**'],
      forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }],
    } as unknown as IBoundaryRule;
    const { result } = evaluate(files, [rule], { knownPackages: ['@scope/kernel-a'] });
    const c = result.coverage[0]!;
    expect(c.deadUnits).toEqual([]);
    expect(unit(c, 'forbiddenImports', '@scope/plugin-react').state).toBe(UnitLivenessState.IntendedEmpty);
    expect(c.unitAcceptance).toMatchObject({ expected: 1, examined: 0, acceptedBy: 'expectEmpty' });
    const settled = settleVerdict(0, ruleVerdictRecords(c.coverage, c.unitAcceptance));
    expect(settled.exit).toBe(0);
    expect(settled.accepted.join('\n')).toContain('accepted by expectEmpty: examined 0 of 1 selector units');
  });

  test('a malformed hand-built marker is an errored rule — skipped, failing, named; no crash', () => {
    const rule = { id: 'bad', title: 'bad', from: ['src/**'], forbiddenImports: [{ pattern: 'y' }] } as unknown as IBoundaryRule;
    const { result } = evaluate(files, [rule]);
    expect(result.invalidRules).toEqual([
      { ruleId: 'bad', problems: ['forbiddenImports[0]: an object entry must set expectEmpty: true — write the plain string otherwise'] },
    ]);
    expect(result.coverage[0]).toMatchObject({ ruleId: 'bad', status: 'skipped', failedOnEmpty: true });
    expect(result.coverage[0]!.skipReason).toContain('failed validation — NOT evaluated');
  });

  test('an unmarked unit that matches nothing is dead, worded with the one causes sentence', () => {
    const rule: IBoundaryRule = { id: 'r', title: 'r', from: ['packages/app/**'], forbiddenImports: ['@scope/plugin-react'] };
    const { result } = evaluate(files, [rule]);
    expect(result.deadUnits.map((d) => [d.unit, d.selector])).toEqual([['forbidden', '@scope/plugin-react']]);
    expect(result.deadUnits[0]!.reason.endsWith(` — ${DEAD_SELECTOR_CAUSES}`)).toBe(true);
    expect(result.deadUnits[0]!.reason).not.toContain('typo or retired target');
  });
});

describe('went live, per signal', () => {
  const app = { 'packages/app/src/x.ts': "import { u } from '@scope/util';\nexport const x = u;\n" };
  const fence = (forbidden: readonly unknown[]): IBoundaryRule =>
    ({ id: 'fence', title: 'fence', from: ['packages/app/**'], forbiddenImports: forbidden }) as unknown as IBoundaryRule;
  const marked = (pattern: string) => ({ pattern, expectEmpty: true });

  test('a workspace package name — and a dependency declaration — through the known-package seam', () => {
    const planned = evaluate(app, [fence([marked('@scope/plugin-react')])], { knownPackages: [] }).result.coverage[0]!;
    expect(unit(planned, 'forbiddenImports', '@scope/plugin-react').state).toBe(UnitLivenessState.IntendedEmpty);
    for (const known of [['@scope/plugin-react'], ['react', '@scope/plugin-react']]) {
      const live = evaluate(app, [fence([marked('@scope/plugin-react')])], { knownPackages: known }).result.coverage[0]!;
      const u = unit(live, 'forbiddenImports', '@scope/plugin-react');
      expect(u.state).toBe(UnitLivenessState.WentLive);
      expect(u.message).toContain("expectEmpty is stale: no import yet, but '@scope/plugin-react' is a known package");
      expect(u.message).toContain('the fence went live; remove expectEmpty');
      expect(live.deadUnits).toEqual([]);
      expect(live.unitAcceptance).toBeUndefined();
    }
  });

  test('a tsconfig alias (the real alias loader)', () => {
    const files = {
      ...app,
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@scope/plugin-react': ['packages/plugin-react/src/index.ts'] } } }),
    };
    const root = tree(files);
    const scan = scanImports({ projectRoot: root });
    const r = evaluateBoundaries(scan, [fence([marked('@scope/plugin-react')])], { tsconfigPaths: loadTsconfigPaths(root) });
    const u = unit(r.coverage[0]!, 'forbiddenImports', '@scope/plugin-react');
    expect(u.state).toBe(UnitLivenessState.WentLive);
    expect(u.message).toContain("the tsconfig alias '@scope/plugin-react' names it");
  });

  test('a file the pattern names', () => {
    const planned = evaluate(app, [fence([marked('src/legacy/**')])]).result.coverage[0]!;
    expect(unit(planned, 'forbiddenImports', 'src/legacy/**').state).toBe(UnitLivenessState.IntendedEmpty);
    const live = evaluate({ ...app, 'src/legacy/old.ts': 'export const o = 1;\n' }, [fence([marked('src/legacy/**')])]).result.coverage[0]!;
    const u = unit(live, 'forbiddenImports', 'src/legacy/**');
    expect(u.state).toBe(UnitLivenessState.WentLive);
    expect(u.message).toContain("the file 'src/legacy/old.ts' matches it");
  });

  test("the '@scope/kernel' layer root: the family wildcard does not cover it — it goes live only with a root package", () => {
    const rule = fence(['@scope/kernel-*', marked('@scope/kernel')]);
    const family = evaluate(app, [rule], { knownPackages: ['@scope/kernel-a'] }).result.coverage[0]!;
    expect(unit(family, 'forbiddenImports', '@scope/kernel-*').state).toBe(UnitLivenessState.Live);
    expect(unit(family, 'forbiddenImports', '@scope/kernel').state).toBe(UnitLivenessState.IntendedEmpty);
    const root = evaluate(app, [rule], { knownPackages: ['@scope/kernel-a', '@scope/kernel'] }).result.coverage[0]!;
    expect(unit(root, 'forbiddenImports', '@scope/kernel').state).toBe(UnitLivenessState.WentLive);
  });

  test('an import of the target: went live, and a local marker fails only under the flags; a pack marker never', () => {
    const files = { ...app, 'tools/uses.ts': "import { r } from '@scope/plugin-react';\nexport const q = r;\n" };
    const live = evaluate(files, [fence([marked('@scope/plugin-react')])]).result.coverage[0]!;
    const u = unit(live, 'forbiddenImports', '@scope/plugin-react');
    expect(u.state).toBe(UnitLivenessState.WentLive);
    expect(u.message).toContain('expectEmpty is stale: 1 import(s) match it');
    const flags = { failOnDeadUnits: false, strict: false, strictPromotesWarnings: true };
    expect(selectorUnitFails(u, flags)).toBe(false);
    expect(selectorUnitFails(u, { ...flags, failOnDeadUnits: true })).toBe(true);
    expect(selectorUnitFails(u, { ...flags, strict: true })).toBe(true);
    const packRule = { ...fence(['@scope/plugin-react']), expectEmptyUnits: [{ list: 'forbiddenImports', unit: '@scope/plugin-react', packageName: '@r13/fence-pack' }] };
    const pack = unit(evaluate(files, [packRule]).result.coverage[0]!, 'forbiddenImports', '@scope/plugin-react');
    expect(pack.state).toBe(UnitLivenessState.WentLive);
    expect(pack.message).toContain('[marker from pack @r13/fence-pack: reported as INFO, never fails]');
    expect(selectorUnitFails(pack, { failOnDeadUnits: true, strict: true, strictPromotesWarnings: true })).toBe(false);
  });

  test('a planned from glob and a planned exemption: intended empty → went live when their files appear', () => {
    const rule = {
      id: 'scope',
      title: 'scope',
      from: ['packages/app/**', { pattern: 'packages/plugin-react/**', expectEmpty: true }, { pattern: '!packages/app/**/*.stories.ts', expectEmpty: true }],
      exemptFiles: [{ pattern: 'packages/app/src/generated/**', expectEmpty: true }],
      forbiddenImports: ['@scope/kernel-*'],
    } as unknown as IBoundaryRule;
    const planned = evaluate(app, [rule], { knownPackages: ['@scope/kernel-a'] }).result.coverage[0]!;
    expect(unit(planned, 'from', 'packages/plugin-react/**').state).toBe(UnitLivenessState.IntendedEmpty);
    expect(unit(planned, 'from', '!packages/app/**/*.stories.ts').state).toBe(UnitLivenessState.IntendedEmpty);
    expect(unit(planned, 'exemptFiles', 'packages/app/src/generated/**').state).toBe(UnitLivenessState.IntendedEmpty);
    // The planned from glob is not a coverage gap: the rule is fully covered, and the acceptance names all three.
    expect(planned.coverage).toEqual({ unit: 'scope globs', expected: 1, examined: 1 });
    expect(planned.unitAcceptance).toMatchObject({ unit: 'selector units', expected: 3, examined: 0, acceptedBy: 'expectEmpty' });
    expect(planned.deadUnits).toEqual([]);

    const grown = evaluate(
      {
        ...app,
        'packages/plugin-react/src/index.ts': 'export const p = 1;\n',
        'packages/app/src/button.stories.ts': 'export const s = 1;\n',
        'packages/app/src/generated/g.ts': 'export const g = 1;\n',
      },
      [rule],
      { knownPackages: ['@scope/kernel-a'] },
    ).result.coverage[0]!;
    expect(unit(grown, 'from', 'packages/plugin-react/**').state).toBe(UnitLivenessState.WentLive);
    expect(unit(grown, 'from', '!packages/app/**/*.stories.ts').state).toBe(UnitLivenessState.WentLive);
    expect(unit(grown, 'exemptFiles', 'packages/app/src/generated/**').state).toBe(UnitLivenessState.WentLive);
    expect(grown.unitAcceptance).toBeUndefined();
    expect(grown.units?.wentLive).toHaveLength(3);
  });

  test('a rule ahead of its only directory is IntendedEmpty (accepted, never failOnEmpty); its unmarked twin fails on empty', () => {
    const marked1 = { id: 'future', title: 'f', from: [{ pattern: 'packages/plugin-react/**', expectEmpty: true }], forbiddenImports: ['@scope/kernel-*'] } as unknown as IBoundaryRule;
    const run = evaluate(app, [marked1]).result;
    const c = run.coverage[0]!;
    expect(c.status).toBe('passed');
    expect(c.failedOnEmpty).toBeUndefined();
    expect(c.coverage).toMatchObject({ acceptedBy: 'expectEmpty', expected: 1, examined: 0 });
    // The acceptance IS the rule's coverage (one record — folded once).
    expect(c.unitAcceptance).toBe(c.coverage);
    // K6: it examined 0 files — accepted, never counted as evaluated.
    expect(c.acceptedAsIntendedEmpty).toBe(true);
    expect([run.rulesEvaluated, run.rulesAcceptedEmpty]).toEqual([0, 1]);
    const twinRun = evaluate(app, [{ id: 'future', title: 'f', from: ['packages/plugin-react/**'], forbiddenImports: ['@scope/kernel-*'] }]).result;
    const twin = twinRun.coverage[0]!;
    expect(twin.status).toBe('skipped');
    expect(twin.failedOnEmpty).toBe(true);
    expect(twin.acceptedAsIntendedEmpty).toBeUndefined();
    expect([twinRun.rulesEvaluated, twinRun.rulesAcceptedEmpty]).toEqual([0, 0]);
  });

  test('a marked from glob whose files are all exempt went live but still governs nothing: never accepted, never 2 → 0', () => {
    const rule = {
      id: 'exempted',
      title: 'e',
      from: [{ pattern: 'packages/app/**', expectEmpty: true }],
      exemptFiles: ['packages/app/**'],
      forbiddenImports: ['@scope/kernel-*'],
    } as unknown as IBoundaryRule;
    const c = evaluate(app, [rule]).result.coverage[0]!;
    const u = unit(c, 'from', 'packages/app/**');
    expect(u.state).toBe(UnitLivenessState.WentLive);
    expect(u.effective).toBe(false);
    expect(u.message).toContain('it still contributes nothing');
    expect(c.status).toBe('skipped');
    expect(c.unitAcceptance).toBeUndefined();
  });

  test('a went-live reason quotes evidence: a leading wildcard never names an unrelated package, a relative pattern says it is never judged dead', () => {
    // Round 13 review: `*-legacy` read "expectEmpty is stale: no import yet, but
    // '_http_agent' is a known package" — the permissive could-match of a
    // leading `*` printed as if it were evidence. The state is unchanged
    // (DECISIONS: the went-live signal is `resolvable`); only the words are.
    // The LOADER refuses a marker on such a pattern (K5 — 'every refusal'
    // above); a hand-built rule handed straight to the engine still reads
    // went-live, quoting why it is never judged dead.
    const rule = fence([marked('*-legacy'), marked('../legacy/**'), marked('@scope/kernel*')]);
    const c = evaluate(app, [rule], { knownPackages: ['assert', '@scope/kernel-a'] }).result.coverage[0]!;
    const wild = unit(c, 'forbiddenImports', '*-legacy');
    expect(wild.state).toBe(UnitLivenessState.WentLive);
    expect(wild.message).toContain(
      'expectEmpty is stale: no import yet, but a leading wildcard could match any known package name, so it is never judged dead',
    );
    expect(wild.message).not.toContain('is a known package');
    const rel = unit(c, 'forbiddenImports', '../legacy/**');
    expect(rel.state).toBe(UnitLivenessState.WentLive);
    expect(rel.message).toContain('a relative pattern is never judged dead (it cannot be judged without an importing file)');
    // A package the pattern really matches is still named.
    const family = unit(c, 'forbiddenImports', '@scope/kernel*');
    expect(family.message).toContain("'@scope/kernel-a' is a known package");
    // Unmarked, both unjudgeable patterns stay live — never dead — as before.
    const plain = evaluate(app, [fence(['*-legacy', '../legacy/**'])], { knownPackages: ['assert'] }).result.coverage[0]!;
    expect(plain.forbidden.map((f) => [f.pattern, f.resolvable, f.state])).toEqual([
      ['*-legacy', true, UnitLivenessState.Live],
      ['../legacy/**', true, UnitLivenessState.Live],
    ]);
    expect(plain.deadUnits).toEqual([]);
  });
});
