import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { evaluatePolicy, inspectSharkcraft } from '../index.ts';

describe('pack-contributed policy checks', () => {
  it('passes when no packs contribute policy checks', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r9-pol-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await evaluatePolicy(inspection);
      expect(r.summary.passed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
