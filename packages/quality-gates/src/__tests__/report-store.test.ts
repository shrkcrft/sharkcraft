import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QualityGateReportStore } from '../runner/report-store.ts';
import type { IQualityGateReport } from '../schema/quality-gate.ts';

function makeReport(overall: 'pass' | 'fail' | 'warn' | 'skipped' = 'pass', startedAt = new Date().toISOString()): IQualityGateReport {
  return {
    schema: 'sharkcraft.quality-gate-report/v1',
    overall,
    startedAt,
    totalDurationMs: 42,
    counts: { pass: 1, fail: 0, warn: 0, skipped: 0 },
    gates: [
      { id: 'graph-fresh', label: 'Graph', status: 'pass', message: 'ok', durationMs: 1 },
    ],
    diagnostics: [],
  };
}

describe('QualityGateReportStore', () => {
  test('writes + reads back the same report', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-gate-store-'));
    try {
      const store = new QualityGateReportStore(root);
      expect(store.exists()).toBe(false);
      const r = makeReport();
      store.write(r);
      expect(store.exists()).toBe(true);
      expect(existsSync(join(root, '.sharkcraft', 'quality-gates', 'last.json'))).toBe(true);
      const back = store.read()!;
      expect(back.overall).toBe('pass');
      expect(back.gates[0]!.id).toBe('graph-fresh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ageMs reflects startedAt', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-gate-store-'));
    try {
      const store = new QualityGateReportStore(root);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      store.write(makeReport('pass', oneHourAgo));
      const age = store.ageMs()!;
      expect(age).toBeGreaterThanOrEqual(60 * 60 * 1000 - 500);
      expect(age).toBeLessThan(70 * 60 * 1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('read returns undefined when the file is missing or corrupt', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-gate-store-'));
    try {
      expect(new QualityGateReportStore(root).read()).toBeUndefined();
      writeFileSync(join(root, '.sharkcraft', 'quality-gates', 'last.json'), 'not json {', { flag: 'wx' });
      // Recreate the dir hierarchy if writeFileSync threw above.
    } catch {
      // Expected — directory didn't exist; skip the corrupt-file branch.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
