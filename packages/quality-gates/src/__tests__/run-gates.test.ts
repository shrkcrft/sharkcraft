import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import type { IPolicyRule } from '@shrkcrft/core';
import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import { runQualityGates } from '../runner/run-gates.ts';

function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-gates-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    "export const alpha = 1;",
  );
  return root;
}

describe('runQualityGates', () => {
  test('overall is fail when graph index is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-gates-missing-'));
    try {
      const report = runQualityGates({ projectRoot: root });
      expect(report.overall).toBe('fail');
      const graphGate = report.gates.find((g) => g.id === 'graph-fresh')!;
      expect(graphGate.status).toBe('fail');
      expect(graphGate.nextCommands).toContain('shrk graph index');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('overall is pass on a clean indexed project (no diff vs main, no arch errors)', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const report = runQualityGates({ projectRoot: root, disable: ['impact'] });
      expect(['pass', 'warn']).toContain(report.overall);
      const graphGate = report.gates.find((g) => g.id === 'graph-fresh')!;
      expect(graphGate.status).toBe('pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('schema field matches the constant', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const report = runQualityGates({ projectRoot: root, disable: ['impact'] });
      expect(report.schema).toBe('sharkcraft.quality-gate-report/v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('policy gate: skipped (never a silent pass) when no policy rules configured', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const report = runQualityGates({ projectRoot: root, disable: ['impact'] });
      const policy = report.gates.find((g) => g.id === 'policy')!;
      expect(policy).toBeDefined();
      expect(policy.status).toBe('skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('policy gate: fails on a policy violation in scope', () => {
    const root = setupFixture();
    try {
      writeFileSync(join(root, 'packages', 'alpha', 'src', 'bad.ts'), "console.log('x');\n");
      buildFullIndex({ projectRoot: root });
      const rule: IPolicyRule = {
        id: 'no-console',
        surface: 'ts',
        pattern: 'console\\.log',
        message: 'No console.log in production code.',
        severity: 'error',
      };
      const report = runQualityGates({
        projectRoot: root,
        disable: ['impact'],
        policy: { rules: [rule] },
      });
      const policy = report.gates.find((g) => g.id === 'policy')!;
      expect(policy.status).toBe('fail');
      expect(report.overall).toBe('fail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('policy gate: changed-only filters out-of-scope rules → skipped, not a silent pass', () => {
    const root = setupFixture();
    try {
      writeFileSync(join(root, 'packages', 'alpha', 'src', 'bad.ts'), "console.log('x');\n");
      buildFullIndex({ projectRoot: root });
      const rule: IPolicyRule = {
        id: 'no-console',
        surface: 'ts',
        pattern: 'console\\.log',
        message: 'No console.log in production code.',
        severity: 'error',
      };
      // The only changed file is a non-ts path, so the ts-surface rule is out of
      // scope under --changed-only — the violating bad.ts must NOT be scanned.
      const report = runQualityGates({
        projectRoot: root,
        disable: ['impact'],
        policy: { rules: [rule], changedOnly: true, changedFiles: ['README.md'] },
      });
      const policy = report.gates.find((g) => g.id === 'policy')!;
      expect(policy.status).toBe('skipped');
      expect(policy.message).toContain('nothing evaluated');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('policy gate: changed-only runs the rule when a changed file matches its glob', () => {
    const root = setupFixture();
    try {
      writeFileSync(join(root, 'packages', 'alpha', 'src', 'bad.ts'), "console.log('x');\n");
      buildFullIndex({ projectRoot: root });
      const rule: IPolicyRule = {
        id: 'no-console',
        surface: 'ts',
        pattern: 'console\\.log',
        message: 'No console.log in production code.',
        severity: 'error',
      };
      const report = runQualityGates({
        projectRoot: root,
        disable: ['impact'],
        policy: {
          rules: [rule],
          changedOnly: true,
          changedFiles: ['packages/alpha/src/bad.ts'],
        },
      });
      const policy = report.gates.find((g) => g.id === 'policy')!;
      expect(policy.status).toBe('fail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('knowledge-symbol gate: reds on a stale symbol reference', () => {
    const root = setupFixture();
    try {
      // `movedSym` lives in moved.ts, but the knowledge entry pins it to
      // index.ts — a moved/renamed symbol the graph resolves cross-file.
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'moved.ts'),
        'export const movedSym = 2;\n',
      );
      buildFullIndex({ projectRoot: root });
      const inspection = {
        projectRoot: root,
        knowledgeEntries: [
          {
            id: 'k-moved',
            title: 'Moved symbol entry',
            type: 'pattern',
            priority: 'normal',
            scope: [],
            tags: [],
            appliesWhen: [],
            content: 'references a symbol that no longer lives at the pinned path',
            references: [
              { kind: 'symbol', symbol: 'movedSym', path: 'packages/alpha/src/index.ts' },
            ],
          },
        ],
        templates: [],
      } as unknown as ISharkcraftInspection;
      const report = runQualityGates({
        projectRoot: root,
        disable: ['impact'],
        knowledgeSymbol: { inspection },
      });
      const gate = report.gates.find((g) => g.id === 'knowledge-symbol')!;
      expect(gate).toBeDefined();
      expect(gate.status).toBe('fail');
      expect(report.overall).toBe('fail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('knowledge-symbol gate: skipped when no inspection is supplied', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const report = runQualityGates({ projectRoot: root, disable: ['impact'] });
      // The gate only runs when an inspection is injected, so it is absent.
      expect(report.gates.find((g) => g.id === 'knowledge-symbol')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('disable filter skips gates by id', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const report = runQualityGates({
        projectRoot: root,
        disable: ['arch', 'impact'],
      });
      expect(report.gates.find((g) => g.id === 'arch')).toBeUndefined();
      expect(report.gates.find((g) => g.id === 'impact')).toBeUndefined();
      expect(report.gates.find((g) => g.id === 'graph-fresh')).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
