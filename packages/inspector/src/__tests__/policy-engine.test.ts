import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { evaluatePolicy, inspectSharkcraft } from '../index.ts';

describe('policy engine', () => {
  it('produces a structured report', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-pol-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await evaluatePolicy(inspection);
      expect(r.schema).toBe('sharkcraft.policy-report/v1');
      expect(r.summary.passed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
