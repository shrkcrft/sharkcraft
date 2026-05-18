import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildRepositoryMemory,
  buildTaskRiskReport,
  inspectSharkcraft,
  saveRepositoryMemory,
  TaskRiskLevel,
} from '../index.ts';

function setupRoot(synthesize: boolean): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r24-mem-risk-'));
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  if (synthesize) {
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
        affectedConstructs: [{ id: 'plugin-api' }, { id: 'plugin-api' }, { id: 'plugin-api' }],
        verificationResults: [
          { command: 'bun test', exitCode: 1 },
        ],
      }),
    );
    writeFileSync(
      nodePath.join(reports, 'arch.json'),
      JSON.stringify({
        violations: [
          { ruleId: 'plugin-api-no-impl', file: 'libs/plugin-api/x.ts', severity: 'error' },
          { ruleId: 'plugin-api-no-impl', file: 'libs/plugin-api/y.ts', severity: 'error' },
        ],
      }),
    );
    writeFileSync(
      nodePath.join(plans, 'p1.json'),
      JSON.stringify({
        schema: 'sharkcraft.plan/v2',
        templateId: 'tpl',
        expectedChanges: [
          { type: 'conflict', relativePath: 'libs/plugin-api/conflict.ts', sizeBytes: 5 },
        ],
      }),
    );
  }
  return root;
}

describe('memory-weighted risk', () => {
  it('missing memory does not fail and reports missing=true', async () => {
    const root = setupRoot(false);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await buildTaskRiskReport('fix bug in module', inspection, {
        includeMemory: true,
      });
      expect(r.memory).toBeDefined();
      expect(r.memory!.missing).toBe(true);
      expect(r.memory!.score).toBe(0);
      expect(r.score).toBe(r.baseScore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('memory raises low/medium risk via touch-hotspot signals', async () => {
    const root = setupRoot(true);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const idx = await buildRepositoryMemory(inspection);
      saveRepositoryMemory(root, idx);
      const r = await buildTaskRiskReport(
        'change plugin-api public API for adapter rules',
        inspection,
        { includeMemory: true },
      );
      expect(r.memory).toBeDefined();
      expect(r.memory!.score).toBeGreaterThan(0);
      expect(r.adjustedScore).toBeGreaterThanOrEqual(r.baseScore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('memory adjustment is capped (never blows past cap)', async () => {
    const root = setupRoot(true);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const idx = await buildRepositoryMemory(inspection);
      saveRepositoryMemory(root, idx);
      const r = await buildTaskRiskReport(
        'plugin plugin api plugin api adapter capability',
        inspection,
        { includeMemory: true },
      );
      expect(r.memory!.score).toBeLessThanOrEqual(r.memory!.cap);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('memory never lowers base risk', async () => {
    const root = setupRoot(true);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const idx = await buildRepositoryMemory(inspection);
      saveRepositoryMemory(root, idx);
      const r = await buildTaskRiskReport('docs cleanup', inspection, { includeMemory: true });
      expect(r.adjustedScore).toBeGreaterThanOrEqual(r.baseScore);
      // Base risk level is preserved or escalated, never reduced.
      const order = {
        [TaskRiskLevel.Low]: 0,
        [TaskRiskLevel.Medium]: 1,
        [TaskRiskLevel.High]: 2,
        [TaskRiskLevel.Critical]: 3,
      };
      expect(order[r.adjustedRiskLevel]).toBeGreaterThanOrEqual(order[r.baseRiskLevel]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('risk output includes base + adjusted fields when memory is requested', async () => {
    const root = setupRoot(false);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await buildTaskRiskReport('refactor service', inspection, { includeMemory: true });
      expect(typeof r.baseScore).toBe('number');
      expect(typeof r.adjustedScore).toBe('number');
      expect(r.baseRiskLevel).toBeDefined();
      expect(r.adjustedRiskLevel).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
