import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { analyzeTestImpact, inspectSharkcraft } from '../index.ts';

describe('test impact v2', () => {
  it('emits minimal + full commands and confidence', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r10-ti-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '0.0.0', scripts: { test: 'bun test' } }),
      );
      mkdirSync(nodePath.join(root, 'src'));
      mkdirSync(nodePath.join(root, 'tests'));
      writeFileSync(nodePath.join(root, 'src/foo.ts'), '');
      writeFileSync(nodePath.join(root, 'tests/foo.spec.ts'), '');
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = analyzeTestImpact(inspection, { files: ['src/foo.ts'] });
      expect(r.likelyTestFiles).toContain('tests/foo.spec.ts');
      expect(r.minimalCommands.length).toBeGreaterThan(0);
      expect(r.fullCommands.length).toBeGreaterThan(0);
      expect(r.confidence).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
