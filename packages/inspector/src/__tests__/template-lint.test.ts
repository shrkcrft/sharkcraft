import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { inspectSharkcraft, lintTemplates, testTemplates } from '../index.ts';

describe('template lint/test', () => {
  it('returns an empty report on an empty workspace', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-tl-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = lintTemplates(inspection);
      expect(r.results.length).toBe(0);
      const t = testTemplates(inspection);
      expect(t.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
