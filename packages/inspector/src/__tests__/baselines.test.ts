import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  compareDriftBaseline,
  compareQualityBaseline,
  createDriftBaseline,
  createQualityBaseline,
  inspectSharkcraft,
} from '../index.ts';

describe('baselines', () => {
  it('creates and compares a quality baseline', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-qb-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const file = nodePath.join(root, 'baseline.json');
      const baseline = await createQualityBaseline(inspection, file);
      expect(existsSync(file)).toBe(true);
      expect(baseline.qualityScore).toBeGreaterThanOrEqual(0);
      const cmp = await compareQualityBaseline(inspection, file);
      expect(cmp).not.toBeNull();
      expect(cmp!.deltas.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates and compares a drift baseline', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-db-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const file = nodePath.join(root, 'drift-baseline.json');
      createDriftBaseline(inspection, file);
      expect(existsSync(file)).toBe(true);
      const cmp = compareDriftBaseline(inspection, file);
      expect(cmp).not.toBeNull();
      // No changes — newFindings should be empty.
      expect(cmp!.newFindings.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
