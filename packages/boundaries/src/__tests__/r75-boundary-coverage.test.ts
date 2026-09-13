/**
 * Round 11 (1.3) — a boundary rule that enforced nothing can never read as
 * evaluated, and a dead selector unit is reported per unit.
 *
 * A rule whose scope glob went dead after a directory rename used to count as
 * "evaluated", and a typo'd forbidden pattern looked exactly like a fence that
 * holds. The evaluator now reports what every rule and every unit matched.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coverageShortfall } from '@shrkcrft/core';
import { evaluateBoundaries, scanImports, type IBoundaryRule, type IEvaluateOptions } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function evaluate(files: Record<string, string>, rules: readonly IBoundaryRule[], options: IEvaluateOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-cov-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return evaluateBoundaries(scanImports({ projectRoot: root }), rules, options);
}

const FILES = {
  'packages/new/y.ts': "import { u } from '@scope/ui';\n",
  'packages/new/empty.ts': 'export const nothing = 0;\n',
  'packages/other/z.ts': "import { left } from 'left-pad';\n",
};

describe('scope coverage', () => {
  test('a rule whose from glob matches no scanned file is SKIPPED, names the glob, and is never evaluated', () => {
    const r = evaluate(FILES, [
      { id: 'old.dead-scope', title: 'Old', severity: 'warning', from: ['packages/old/**'], forbiddenImports: ['@scope/ui'] },
    ]);
    const c = r.coverage[0]!;
    expect(c.status).toBe('skipped');
    expect(c.skipReason).toContain('packages/old/**');
    expect(c.skipReason).toContain('0 of 3 scanned files');
    expect(r.rulesEvaluated).toBe(0);
    expect(r.rulesConfigured).toBe(1);
    expect(coverageShortfall(c.coverage)).toContain('packages/old/**');
  });

  test('a file with zero imports still counts toward filesInScope (the scan file list, not the edges)', () => {
    const r = evaluate(FILES, [
      { id: 'new.fence', title: 'New', severity: 'error', from: ['packages/new/empty.ts'], forbiddenImports: ['x'] },
    ]);
    expect(r.coverage[0]!.status).toBe('passed');
    expect(r.coverage[0]!.filesInScope).toBe(1);
    expect(r.rulesEvaluated).toBe(1);
  });

  test('a dead from glob next to a live sibling is a dead unit and a coverage shortfall', () => {
    const r = evaluate(FILES, [
      { id: 'mixed', title: 'Mixed', severity: 'error', from: ['packages/new/**', 'packages/old/**'], forbiddenImports: ['@scope/ui'] },
    ]);
    const c = r.coverage[0]!;
    expect(c.status).toBe('failed'); // the live glob still found the real violation
    expect(c.deadUnits.map((d) => [d.unit, d.selector])).toContainEqual(['from', 'packages/old/**']);
    expect(c.coverage).toMatchObject({ unit: 'scope globs', expected: 2, examined: 1 });
    expect(coverageShortfall(c.coverage)).toContain('examined 1 of 2 scope globs');
  });

  test('failOnEmpty defaults ON for error rules, OFF for warnings, and an explicit false wins', () => {
    const dead = (over: Partial<IBoundaryRule>): IBoundaryRule => ({
      id: 'd',
      title: 'D',
      from: ['nowhere/**'],
      forbiddenImports: ['x'],
      ...over,
    });
    expect(evaluate(FILES, [dead({ severity: 'error' })]).skipped[0]!.failed).toBe(true);
    expect(evaluate(FILES, [dead({})]).skipped[0]!.failed).toBe(true); // unset severity = error
    expect(evaluate(FILES, [dead({ severity: 'warning' })]).skipped[0]!.failed).toBe(false);
    expect(evaluate(FILES, [dead({ severity: 'error', failOnEmpty: false })]).skipped[0]!.failed).toBe(false);
  });
});

describe('forbidden-pattern resolvability (a typo is dead; a legitimate guard is not)', () => {
  const fence = (forbiddenImports: string[], over: Partial<IBoundaryRule> = {}): IBoundaryRule => ({
    id: 'new.fence',
    title: 'Fence',
    severity: 'error',
    from: ['packages/new/**'],
    forbiddenImports,
    ...over,
  });

  test("a typo'd pattern matching nothing anywhere is a dead unit", () => {
    const r = evaluate(FILES, [fence(['@scope/retierd-pkg'])]);
    expect(r.deadUnits.map((d) => [d.unit, d.selector])).toEqual([['forbidden', '@scope/retierd-pkg']]);
    // Round 13: the one causes sentence (DEAD_SELECTOR_CAUSES) names the third
    // explanation a pre-emptive fence needs — the target does not exist yet.
    expect(r.deadUnits[0]!.reason).toContain('typo, retired target, or a target that does not exist yet (see expectEmpty)');
  });

  test('a pattern naming a known dependency nobody imports is NOT dead', () => {
    const r = evaluate(FILES, [fence(['lodash'])], { knownPackages: ['lodash'] });
    expect(r.deadUnits).toEqual([]);
  });

  test('a pattern hit only by an edge from an OUT-of-scope file is NOT dead', () => {
    const r = evaluate(FILES, [fence(['left-pad'])]);
    expect(r.coverage[0]!.forbidden[0]).toMatchObject({ pattern: 'left-pad', hitsInScope: 0, hitsAnywhere: 1, resolvable: true });
    expect(r.deadUnits).toEqual([]);
  });

  test('a path-like pattern matching an existing file is NOT dead', () => {
    const r = evaluate(FILES, [fence(['packages/other/**'])]);
    expect(r.deadUnits).toEqual([]);
  });

  test("an 'exact' pattern with only subpath imports is dead, and the reason says why", () => {
    const r = evaluate(
      { 'packages/new/a.ts': "import { x } from '@scope/kit/x';\n" },
      [fence(['@scope/kit'], { forbiddenMatch: 'exact' })],
    );
    expect(r.deadUnits[0]?.selector).toBe('@scope/kit');
    expect(r.deadUnits[0]?.reason).toContain("forbiddenMatch: 'exact' excludes them");
  });
});
