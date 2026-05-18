import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { listQualityBaselineHistory } from '../index.ts';

const sample = {
  schema: 'sharkcraft.quality-baseline/v1',
  projectRoot: '/tmp',
  sharkcraftVersion: '0.1.0',
  configHash: 'abc',
  qualityScore: 80,
  readinessScore: 70,
  blockers: 0,
  warnings: 1,
  gates: [],
  categoryScores: [],
  driftFindings: 0,
  driftErrors: 0,
  driftWarnings: 0,
  packSignatures: { total: 1, verified: 1, unverified: 0, invalid: 0, notChecked: 0 },
};

describe('r12 baseline history', () => {
  test('lists snapshots newest first', () => {
    const cwd = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-history-'));
    const dir = nodePath.join(cwd, '.sharkcraft', 'baselines');
    mkdirSync(dir, { recursive: true });
    writeFileSync(nodePath.join(dir, 'a.json'), JSON.stringify({ ...sample, createdAt: '2026-05-10T00:00:00Z' }));
    writeFileSync(nodePath.join(dir, 'b.json'), JSON.stringify({ ...sample, createdAt: '2026-05-12T00:00:00Z' }));
    writeFileSync(nodePath.join(dir, 'c.json'), JSON.stringify({ ...sample, createdAt: '2026-05-11T00:00:00Z' }));
    const h = listQualityBaselineHistory(cwd);
    expect(h.entries.length).toBe(3);
    expect(h.entries[0]!.createdAt).toBe('2026-05-12T00:00:00Z');
    expect(h.latest?.createdAt).toBe('2026-05-12T00:00:00Z');
    expect(h.previous?.createdAt).toBe('2026-05-11T00:00:00Z');
  });

  test('empty dir returns empty history', () => {
    const cwd = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-history-2-'));
    const h = listQualityBaselineHistory(cwd);
    expect(h.entries.length).toBe(0);
    expect(h.latest).toBeNull();
    expect(h.previous).toBeNull();
  });
});
