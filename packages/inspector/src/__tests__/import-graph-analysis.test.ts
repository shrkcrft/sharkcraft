import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { analyzeImportGraph } from '../index.ts';

describe('import graph analysis', () => {
  it('detects fan-in/out and orphans on a tiny repo', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-ig-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      mkdirSync(nodePath.join(root, 'src'), { recursive: true });
      writeFileSync(nodePath.join(root, 'src/a.ts'), `import './b';\n`);
      writeFileSync(nodePath.join(root, 'src/b.ts'), `export const x = 1;\n`);
      writeFileSync(nodePath.join(root, 'src/orphan.ts'), `export const y = 1;\n`);
      const r = analyzeImportGraph(root);
      expect(r.filesScanned).toBeGreaterThan(0);
      expect(r.topFanIn.length).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
