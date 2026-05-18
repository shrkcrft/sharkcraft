import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanImports } from '../index.ts';

describe('scanImports', () => {
  test('captures import/export/require/dynamic-import specifiers', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-scan-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'a.ts'),
        [
          "import x from 'lodash';",
          "import './local';",
          "export { y } from '@scope/y';",
          "const z = require('zod');",
          "const m = await import('foo');",
        ].join('\n'),
      );
      const r = scanImports({ projectRoot: root });
      const specs = r.edges.map((e) => e.importSpecifier);
      expect(specs).toContain('lodash');
      expect(specs).toContain('./local');
      expect(specs).toContain('@scope/y');
      expect(specs).toContain('zod');
      expect(specs).toContain('foo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores node_modules / dist / .sharkcraft', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-scan-ignore-'));
    try {
      mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'foo', 'a.ts'), "import 'should-be-ignored';");
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'dist', 'a.ts'), "import 'should-be-ignored';");
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), "import 'real';");
      const r = scanImports({ projectRoot: root });
      const specs = r.edges.map((e) => e.importSpecifier);
      expect(specs).toContain('real');
      expect(specs).not.toContain('should-be-ignored');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
