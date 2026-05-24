import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
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
