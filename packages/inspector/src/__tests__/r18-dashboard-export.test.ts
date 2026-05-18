import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { buildDashboardExport, inspectSharkcraft } from '../index.ts';

describe('r18 dashboard data export', () => {
  test('writes index.json + selected sections', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const out = mkdtempSync(nodePath.join(tmpdir(), 'r18-dash-export-'));
    try {
      const r = await buildDashboardExport(inspection, {
        outputDir: out,
        include: ['repository-map', 'role-views'],
      });
      expect(existsSync(nodePath.join(out, 'index.json'))).toBe(true);
      expect(existsSync(nodePath.join(out, 'repository-map.json'))).toBe(true);
      expect(existsSync(nodePath.join(out, 'role-views.json'))).toBe(true);
      expect(r.entries.length).toBe(2);
      const idx = JSON.parse(readFileSync(nodePath.join(out, 'index.json'), 'utf8'));
      expect(idx.schema).toBe('sharkcraft.dashboard-export/v1');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
