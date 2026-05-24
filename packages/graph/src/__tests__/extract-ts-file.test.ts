import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTsFile } from '../indexer/extract-ts-file.ts';
import { fingerprintFile } from '../store/file-fingerprint.ts';
import { EdgeKind } from '../schema/edge-kind.ts';
import { NodeKind } from '../schema/node-kind.ts';

describe('extractTsFile', () => {
  test('captures exports, locals, re-exports, and raw import specifiers', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-extract-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const fileAbs = join(root, 'src', 'demo.ts');
      writeFileSync(
        fileAbs,
        [
          "import { foo } from './foo';",
          "import bar from 'external-pkg';",
          "export const PI = 3.14;",
          "export function greet() { return 'hi'; }",
          "function helper() { return 1; }",
          "export { other } from './other';",
          "export * from './star';",
        ].join('\n'),
      );
      const fp = fingerprintFile(fileAbs, root);
      const ex = extractTsFile(fp, fileAbs);

      expect(ex.fileNode.kind).toBe(NodeKind.File);
      expect(ex.fileNode.path).toBe('src/demo.ts');

      const symbolNames = ex.symbolNodes.map((s) => s.label).sort();
      expect(symbolNames).toContain('PI');
      expect(symbolNames).toContain('greet');
      expect(symbolNames).toContain('helper');

      const declares = ex.edges.filter((e) => e.kind === EdgeKind.DeclaresSymbol);
      expect(declares.length).toBe(ex.symbolNodes.length);

      const reExports = ex.edges.filter((e) => e.kind === EdgeKind.ReExportsSymbol);
      // Two re-export statements: `export { other } from './other'` and `export * from './star'`.
      expect(reExports.length).toBe(2);

      const specs = ex.rawImportSpecifiers.map((r) => r.specifier).sort();
      expect(specs).toContain('./foo');
      expect(specs).toContain('external-pkg');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tags test files', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-extract-test-'));
    try {
      mkdirSync(join(root, '__tests__'), { recursive: true });
      const fileAbs = join(root, '__tests__', 'a.test.ts');
      writeFileSync(fileAbs, "export const x = 1;");
      const fp = fingerprintFile(fileAbs, root);
      const ex = extractTsFile(fp, fileAbs);
      expect(ex.fileNode.tags).toContain('test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
