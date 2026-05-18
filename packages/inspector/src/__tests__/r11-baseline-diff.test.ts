import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { diffQualityBaselineFiles, pruneQualityBaselines } from '../index.ts';

const sample = {
  schema: 'sharkcraft.quality-baseline/v1',
  createdAt: '2026-05-12T00:00:00Z',
  projectRoot: '/tmp/sample',
  sharkcraftVersion: '0.1.0',
  configHash: 'abc123',
  qualityScore: 80,
  readinessScore: 70,
  blockers: 1,
  warnings: 3,
  gates: [{ id: 'doctor', passed: true, errors: 0, warnings: 0 }],
  categoryScores: [{ id: 'coverage:rules', score: 65 }],
  driftFindings: 4,
  driftErrors: 0,
  driftWarnings: 4,
  packSignatures: { total: 1, verified: 1, unverified: 0, invalid: 0, notChecked: 0 },
};

describe('r11 baseline diff', () => {
  test('detects score / blocker / warning deltas', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-baseline-'));
    const oldFile = nodePath.join(dir, 'old.json');
    const newFile = nodePath.join(dir, 'new.json');
    writeFileSync(oldFile, JSON.stringify(sample), 'utf8');
    const newer = {
      ...sample,
      createdAt: '2026-05-13T00:00:00Z',
      qualityScore: 75,
      blockers: 2,
      warnings: 5,
      gates: [{ id: 'doctor', passed: false, errors: 1, warnings: 0 }],
      categoryScores: [{ id: 'coverage:rules', score: 60 }],
    };
    writeFileSync(newFile, JSON.stringify(newer), 'utf8');
    const diff = diffQualityBaselineFiles(oldFile, newFile)!;
    expect(diff.scoreDelta).toBe(-5);
    expect(diff.blockersDelta).toBe(1);
    expect(diff.warningsDelta).toBe(2);
    expect(diff.newWarnings.some((w) => w.includes('doctor'))).toBe(true);
    expect(diff.categoryDeltas[0]!.delta).toBe(-5);
  });

  test('returns null when a file is missing', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-baseline-2-'));
    expect(diffQualityBaselineFiles(nodePath.join(dir, 'a.json'), nodePath.join(dir, 'b.json'))).toBeNull();
  });
});

describe('r11 baseline prune', () => {
  test('dry-run keeps last N', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-baseline-prune-'));
    const bdir = nodePath.join(dir, '.sharkcraft', 'baselines');
    mkdirSync(bdir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(
        nodePath.join(bdir, `bl-${i}.json`),
        JSON.stringify({ ...sample, createdAt: `2026-05-${10 + i}T00:00:00Z` }),
        'utf8',
      );
    }
    const result = pruneQualityBaselines({ cwd: dir, keep: 2 });
    expect(result.dryRun).toBe(true);
    expect(result.kept.length).toBe(2);
    expect(result.pruned.length).toBe(3);
  });
});
