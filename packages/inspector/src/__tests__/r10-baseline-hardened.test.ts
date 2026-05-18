import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  compareQualityBaseline,
  createQualityBaseline,
  inspectSharkcraft,
  readQualityBaseline,
  renderQualityBaselineHtml,
} from '../index.ts';

describe('quality baseline hardening', () => {
  it('captures version, configHash, categoryScores, packSignatures', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r10-base-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const file = nodePath.join(root, 'baseline.json');
      const baseline = await createQualityBaseline(inspection, file);
      expect(existsSync(file)).toBe(true);
      expect(typeof baseline.sharkcraftVersion).toBe('string');
      expect(Array.isArray(baseline.categoryScores)).toBe(true);
      expect(baseline.packSignatures.total).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders an HTML view and roundtrips through readQualityBaseline', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r10-base-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const file = nodePath.join(root, 'baseline.json');
      await createQualityBaseline(inspection, file);
      const round = readQualityBaseline(file);
      expect(round).not.toBeNull();
      const html = renderQualityBaselineHtml(round!);
      expect(html.startsWith('<!doctype html>')).toBe(true);
      const cmp = await compareQualityBaseline(inspection, file);
      expect(cmp).not.toBeNull();
      const htmlWithCmp = renderQualityBaselineHtml(round!, cmp!);
      expect(htmlWithCmp).toContain('Comparison');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
