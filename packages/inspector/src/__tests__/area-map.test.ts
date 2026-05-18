import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { AreaKind, buildAreaMap, inspectSharkcraft } from '../index.ts';

describe('repository area map', () => {
  it('classifies files into areas', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-am-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      mkdirSync(nodePath.join(root, 'src/core'), { recursive: true });
      mkdirSync(nodePath.join(root, 'tests'), { recursive: true });
      mkdirSync(nodePath.join(root, 'docs'), { recursive: true });
      writeFileSync(nodePath.join(root, 'src/core/index.ts'), '');
      writeFileSync(nodePath.join(root, 'tests/foo.spec.ts'), '');
      writeFileSync(nodePath.join(root, 'docs/overview.md'), '');
      const inspection = await inspectSharkcraft({ cwd: root });
      const map = buildAreaMap(inspection);
      const kinds = new Set(map.areas.map((a) => a.kind));
      expect(kinds.has(AreaKind.Core)).toBe(true);
      expect(kinds.has(AreaKind.Tests)).toBe(true);
      expect(kinds.has(AreaKind.Docs)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
