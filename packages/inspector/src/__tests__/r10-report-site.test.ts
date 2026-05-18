import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { buildReportSite, inspectSharkcraft } from '../index.ts';

describe('static report site', () => {
  it('writes the expected page set', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r10-site-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const out = nodePath.join(root, 'site');
      const r = await buildReportSite(inspection, out);
      const names = readdirSync(out);
      expect(names).toContain('index.html');
      expect(names).toContain('quality.html');
      expect(names).toContain('bundles.html');
      expect(names).toContain('review.html');
      expect(names).toContain('coverage.html');
      expect(names).toContain('drift.html');
      expect(names).toContain('policies.html');
      expect(r.files.length).toBeGreaterThanOrEqual(7);
      expect(existsSync(nodePath.join(out, 'index.html'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
