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

  test('ignores import-like text in comments and string literals, keeps every real import shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-extract-ast-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const fileAbs = join(root, 'src', 'demo.ts');
      writeFileSync(
        fileAbs,
        [
          "// import { ghost } from './ghost-comment';",
          "/* import './ghost-block'; */",
          '/**',
          ' * Example usage:',
          " * import { x } from './ghost-jsdoc';",
          ' */',
          "const sample = `import { y } from './ghost-template';`;",
          "const s = \"import z from './ghost-string'\";",
          "import './side-effect';",
          "import type { T } from './type-only';",
          "import { real } from './real';",
          "export { re } from './re-export';",
          "const lazy = () => import('./dynamic');",
          "const cjs = require('./required');",
          'void sample; void s; void lazy; void cjs;',
        ].join('\n'),
      );
      const fp = fingerprintFile(fileAbs, root);
      const ex = extractTsFile(fp, fileAbs);
      const specs = new Set(ex.rawImportSpecifiers.map((r) => r.specifier));

      // Every real import shape is still captured — so a genuine unresolved /
      // cross-package import is still flagged downstream (no break is masked).
      for (const real of [
        './side-effect',
        './type-only',
        './real',
        './re-export',
        './dynamic',
        './required',
      ]) {
        expect(specs.has(real)).toBe(true);
      }

      // None of the import-like text inside comments, JSDoc, template, or
      // string literals is collected — these were the false positives.
      for (const ghost of [
        './ghost-comment',
        './ghost-block',
        './ghost-jsdoc',
        './ghost-template',
        './ghost-string',
      ]) {
        expect(specs.has(ghost)).toBe(false);
      }
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
