/**
 * Round 11 — the per-file import-edge memo in `scanImports`.
 *
 * Round 11 made the import parse comment-aware (lex → blank comments → match),
 * which is correct but costs a full lex per file. `scanImports` runs several
 * times per command (the architecture map twice and impact analysis once for a
 * single task-risk report) and for the life of the MCP server, so re-lexing
 * every unchanged file on every call made the task-risk / role-view /
 * orchestration / handoff reports ~3x slower than before the round. The memo is
 * the fix; these locks make sure it is a pure cache: an edited file is re-read,
 * an unchanged one gives byte-identical results, and no caller can poison it.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearImportScanMemo, scanImports } from '../scan/scan-imports.ts';

const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-scan-memo-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const specifiers = (root: string): string[] =>
  scanImports({ projectRoot: root })
    .edges.map((e) => `${e.from} -> ${e.importSpecifier}:${e.line}`)
    .sort();

beforeEach(() => clearImportScanMemo());
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('scanImports memo', () => {
  test('a repeated scan of an unchanged tree returns exactly the same edges', () => {
    const root = project({
      'src/a.ts': "import { b } from './b';\n// import { gone } from './gone';\nexport const a = b;\n",
      'src/b.ts': "export const b = 1;\n",
    });
    const first = specifiers(root);
    expect(first).toEqual(['src/a.ts -> ./b:1']);
    expect(specifiers(root)).toEqual(first);
  });

  test('an edited file is re-parsed — the memo never serves a stale edge', () => {
    const root = project({ 'src/a.ts': "import { b } from './b';\n" });
    expect(specifiers(root)).toEqual(['src/a.ts -> ./b:1']);
    writeFileSync(join(root, 'src/a.ts'), "import { c } from './c';\nimport { d } from './d';\n");
    // Force a distinct mtime even on a filesystem with coarse timestamps.
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(root, 'src/a.ts'), later, later);
    expect(specifiers(root)).toEqual(['src/a.ts -> ./c:1', 'src/a.ts -> ./d:2']);
  });

  test('the same file scanned in the other zone is not answered from the wrong memo entry', () => {
    const root = project({ 'src/a.ts': "// import { x } from './x';\nimport { y } from './y';\n" });
    const code = scanImports({ projectRoot: root }).edges.map((e) => e.importSpecifier);
    const all = scanImports({ projectRoot: root, includeComments: true }).edges.map((e) => e.importSpecifier);
    expect(code).toEqual(['./y']);
    expect(all.sort()).toEqual(['./x', './y']);
  });

  test('a caller mutating a returned edge cannot poison the next scan', () => {
    const root = project({ 'src/a.ts': "import { b } from './b';\n" });
    const scan = scanImports({ projectRoot: root });
    scan.edges[0]!.importSpecifier = 'MUTATED';
    expect(scanImports({ projectRoot: root }).edges[0]!.importSpecifier).toBe('./b');
  });

  test('a memoised scan equals an uncached one on a realistic tree', () => {
    const root = project({
      'src/a.ts': "import type { T } from './t';\nexport * from './re';\nconst m = await import('./dyn');\n",
      'src/b.ts': "/* import { no } from './no'; */\nimport './side';\nconst r = require('./req');\n",
      'src/t.ts': 'export type T = 1;\n',
    });
    const cached = (() => {
      specifiers(root);
      return specifiers(root);
    })();
    clearImportScanMemo();
    expect(specifiers(root)).toEqual(cached);
  });
});
