import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildRepositoryMemory,
  inspectSharkcraft,
  loadRepositoryMemory,
  memoryIndexPath,
  memoryRiskForTask,
  resetRepositoryMemory,
  saveRepositoryMemory,
} from '../index.ts';

function setupRoot(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r23-memory-'));
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  // Synthesize a fake history
  const sessions = nodePath.join(root, '.sharkcraft', 'sessions', 's1');
  const reports = nodePath.join(root, '.sharkcraft', 'reports');
  const plans = nodePath.join(root, '.sharkcraft', 'plans');
  mkdirSync(sessions, { recursive: true });
  mkdirSync(reports, { recursive: true });
  mkdirSync(plans, { recursive: true });
  writeFileSync(
    nodePath.join(sessions, 'session.json'),
    JSON.stringify({
      intent: { kind: 'feature' },
      affectedConstructs: [{ id: 'plugin-api' }],
      verificationResults: [
        { command: 'bun test', exitCode: 1, durationMs: 5000 },
        { command: 'bun x tsc --noEmit', exitCode: 0, durationMs: 31000 },
      ],
    }),
  );
  writeFileSync(
    nodePath.join(reports, 'arch.json'),
    JSON.stringify({
      violations: [
        { ruleId: 'plugin-api-no-impl', file: 'libs/x.ts', severity: 'error' },
        { ruleId: 'plugin-api-no-impl', file: 'libs/y.ts', severity: 'error' },
      ],
    }),
  );
  writeFileSync(
    nodePath.join(plans, 'p1.json'),
    JSON.stringify({
      schema: 'sharkcraft.plan/v2',
      templateId: 'tpl',
      expectedChanges: [
        { type: 'conflict', relativePath: 'src/conflict.ts', sizeBytes: 5 },
      ],
    }),
  );
  return root;
}

describe('repo memory', () => {
  it('builds an index from synthetic history', async () => {
    const root = setupRoot();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const idx = await buildRepositoryMemory(inspection);
      expect(idx.sourceCount).toBeGreaterThan(0);
      expect(idx.files.length).toBeGreaterThan(0);
      expect(idx.plansWithConflicts.length).toBeGreaterThan(0);
      // Failed validation command captured
      expect(idx.failedValidationCommands.join(' ')).toContain('bun test');
      // Boundary recurring rule
      expect(idx.boundaryViolationsRecurring).toContain('plugin-api-no-impl');
      // Constructs captured
      expect(idx.highRiskConstructs.find((c) => c.id === 'plugin-api')).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('memory risk augments task risk for matching tokens', async () => {
    const root = setupRoot();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const idx = await buildRepositoryMemory(inspection);
      saveRepositoryMemory(root, idx);
      const loaded = loadRepositoryMemory(root);
      expect(loaded).not.toBeNull();
      const risk = memoryRiskForTask(loaded, 'fix bug in plugin-api implementation');
      expect(['overlap-weak', 'overlap-strong']).toContain(risk.recommendation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reset dry-run does not delete; --write deletes only memory dir', async () => {
    const root = setupRoot();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const idx = await buildRepositoryMemory(inspection);
      saveRepositoryMemory(root, idx);
      expect(existsSync(memoryIndexPath(root))).toBe(true);

      const dry = resetRepositoryMemory(root, { dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(existsSync(memoryIndexPath(root))).toBe(true);

      const real = resetRepositoryMemory(root, { dryRun: false });
      expect(real.dryRun).toBe(false);
      expect(existsSync(memoryIndexPath(root))).toBe(false);
      // Other .sharkcraft content survives.
      expect(
        existsSync(nodePath.join(root, '.sharkcraft', 'reports', 'arch.json')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
