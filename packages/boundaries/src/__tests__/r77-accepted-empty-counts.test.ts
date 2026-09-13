/**
 * r77 — a rule accepted as intended-empty examined 0 files, so it is counted
 * apart from the evaluated ones (round 13, K6): `N evaluated, M accepted as
 * intended-empty`. Real walks over temp trees, through the engine entries the
 * CLI runs (`runPolicyLint`, `runWiring`, `evaluateBoundaries` over a real
 * scan) — the markers are hand-written the way an author writes them and
 * normalised by the entry, never pre-shaped.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IPolicyRule, IWiringRule } from '@shrkcrft/core';
import { evaluateBoundaries } from '../evaluate/evaluate-boundaries.ts';
import type { IBoundaryRule } from '../model/boundary-rule.ts';
import { runPolicyLint } from '../policy/run-policy.ts';
import { scanImports } from '../scan/scan-imports.ts';
import { runWiring } from '../wiring/scan-wiring-files.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-accepted-empty-'));
  roots.push(root);
  for (const [rel, body] of Object.entries({ 'package.json': '{"name":"fx","version":"0.0.0"}', ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('boundaries: rulesEvaluated never counts an accepted intended-empty rule', () => {
  test('a planned rule is rulesAcceptedEmpty, its live sibling is rulesEvaluated', () => {
    const root = tree({ 'packages/app/src/x.ts': "import { u } from '@scope/util';\nexport const x = u;\n" });
    const planned = {
      id: 'planned',
      title: 'planned',
      from: [{ pattern: 'packages/plugin-react/**', expectEmpty: true }],
      forbiddenImports: ['node:fs'],
    } as unknown as IBoundaryRule;
    const live: IBoundaryRule = { id: 'live', title: 'live', from: ['packages/app/**'], forbiddenImports: ['node:fs'] };
    const r = evaluateBoundaries(scanImports({ projectRoot: root }), [planned, live], { knownPackages: ['node:fs'] });
    expect(r.rulesConfigured).toBe(2);
    expect(r.rulesEvaluated).toBe(1);
    expect(r.rulesAcceptedEmpty).toBe(1);
    const [p, l] = [r.coverage.find((c) => c.ruleId === 'planned')!, r.coverage.find((c) => c.ruleId === 'live')!];
    expect(p.acceptedAsIntendedEmpty).toBe(true);
    expect(p.filesInScope + p.exemptFilesInScope).toBe(0);
    expect(p.coverage.acceptedBy).toBe('expectEmpty');
    expect(l.acceptedAsIntendedEmpty).toBeUndefined();
    // The unmarked twin is a skip (checked nothing) — never accepted, never evaluated.
    const twin: IBoundaryRule = { id: 'twin', title: 't', from: ['packages/plugin-react/**'], forbiddenImports: ['node:fs'] };
    const t = evaluateBoundaries(scanImports({ projectRoot: root }), [twin], { knownPackages: ['node:fs'] });
    expect([t.rulesEvaluated, t.rulesAcceptedEmpty, t.coverage[0]!.status]).toEqual([0, 0, 'skipped']);
  });
});

describe('gate planes: the engine counts the accepted rules (acceptedEmpty) beside evaluated', () => {
  test('policy: a rule over a planned directory is accepted and counted in acceptedEmpty', () => {
    const root = tree({ 'src/app/a.ts': 'export const a = 1;\n' });
    const planned = {
      id: 'planned',
      surface: 'ts',
      pattern: 'TODO',
      message: 'no TODO',
      files: [{ pattern: 'src/plugins/**/*.ts', expectEmpty: true }],
    } as unknown as IPolicyRule;
    const live: IPolicyRule = { id: 'live', surface: 'ts', pattern: 'FIXME', message: 'no FIXME', files: ['src/app/**/*.ts'] };
    const r = runPolicyLint(root, [planned, live]);
    // `evaluated` keeps counting it (the verdict path's "nothing ran" guard);
    // `acceptedEmpty` is what a renderer prints apart and subtracts.
    expect([r.evaluated, r.acceptedEmpty, r.skipped.length]).toEqual([2, 1, 0]);
    expect(r.rules.find((x) => x.ruleId === 'planned')?.coverage?.acceptedBy).toBe('expectEmpty');
    // No acceptance, no count: the unmarked twin is the loud skip.
    const twin: IPolicyRule = { id: 'twin', surface: 'ts', pattern: 'TODO', message: 'x', files: ['src/plugins/**/*.ts'], severity: 'warning' };
    const t = runPolicyLint(root, [twin]);
    expect([t.evaluated, t.acceptedEmpty, t.skipped.length]).toEqual([0, 0, 1]);
  });

  test('wiring: a rule whose source side is planned is accepted and counted in acceptedEmpty', () => {
    const root = tree({ 'src/registry.ts': 'export const REGISTERED = [];\n' });
    const planned = {
      id: 'plugins-registered',
      declared: { files: [{ pattern: 'src/plugins/*.ts', expectEmpty: true }], pattern: 'export const (\\w+)_PLUGIN' },
      registered: { files: ['src/registry.ts'], arrayProperty: 'REGISTERED' },
    } as unknown as IWiringRule;
    const r = runWiring(root, [planned]);
    expect([r.evaluated, r.acceptedEmpty, r.skipped.length]).toEqual([1, 1, 0]);
    expect(r.rules[0]!.status).toBe('passed');
    expect(r.rules[0]!.coverage?.acceptedBy).toBe('expectEmpty');
  });
});
