/**
 * Round 11 — 6.1a / 6.1a#line-numbers / 6.1(b): the import extractor reads CODE.
 *
 * Every boundary check, drift, impact and review packet reads imports through
 * `scanImports`, which used to run four private regexes over raw text while a
 * source comment claimed comments were stripped. They were not: a
 * commented-out import was a violation, a doc-comment code fence was an edge, a
 * real import whose clause held an apostrophe in a comment was MISSED, and
 * every import after line 1 was reported one line early. It now reads through
 * THE import parser, zoned by the round-10 code-zone lexer.
 *
 * 6.1(b): blanking comments manufactures long whitespace runs, and a pattern
 * with adjacent whitespace quantifiers goes O(run²) on them while staying fast
 * on ordinary source — invisible in normal testing. These timing locks run each
 * import pattern against synthetic 20K-character blank runs.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseImportStatements, scanImports, type IImportEdge } from '../index.ts';

function scanFiles(files: Record<string, string>, includeComments = false): IImportEdge[] {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-zones-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    }
    return scanImports({ projectRoot: root, includeComments }).edges;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const specs = (edges: readonly IImportEdge[]): string[] => edges.map((e) => e.importSpecifier).sort();

describe('6.1a — imports are read from code, never from comments or strings', () => {
  test('a // import, a /* import */ and a JSDoc ```ts fence yield no edge', () => {
    const edges = scanFiles({
      'src/commented.ts': [
        "// import { A } from '@scope/forbidden';",
        "/* import { B } from '@scope/forbidden'; */",
        '/**',
        ' * ```ts',
        " * import { C } from '@scope/forbidden';",
        ' * ```',
        ' */',
        'export const x = 1;',
      ].join('\n'),
    });
    expect(edges).toEqual([]);
  });

  test("a code statement followed by a comment that merely says `from '…'` yields no edge", () => {
    // The old lazy clause ran from a code `export` across `;` into the comment.
    const edges = scanFiles({ 'src/phantom.ts': "export const ok = 1;\n// … copied from '@scope/forbidden' long ago\n" });
    expect(edges).toEqual([]);
  });

  test('an import whose clause holds a comment with an apostrophe IS found, on its keyword line', () => {
    // The apostrophe used to stop the clause class, so this real forbidden
    // import escaped every boundary rule.
    const edges = scanFiles({
      'src/missed.ts': "const x = 1;\nimport {\n  real, // don't use the legacy one\n} from '@scope/forbidden';\n",
    });
    expect(edges.map((e) => ({ spec: e.importSpecifier, line: e.line }))).toEqual([
      { spec: '@scope/forbidden', line: 2 },
    ]);
  });

  test('an import written inside a string literal yields no edge', () => {
    expect(scanFiles({ 'src/s.ts': "const s = \"import x from 'y'\";\nexport const t = `import z from 'w'`;\n" })).toEqual([]);
  });

  test('a quote inside a regex literal does not hide a later dynamic import', () => {
    const edges = scanFiles({
      'src/esc.ts': [
        "export const esc = (s: string) => s.replace(/[&<>\"']/g, '');",
        'export async function late() {',
        "  return import('@scope/late');",
        '}',
      ].join('\n'),
    });
    expect(specs(edges)).toEqual(['@scope/late']);
    expect(edges[0]?.line).toBe(3);
  });

  test('includeComments: true restores the raw edge set (the escape hatch)', () => {
    const files = { 'src/a.ts': "// import { A } from '@scope/forbidden';\nimport b from 'b';\n" };
    expect(specs(scanFiles(files))).toEqual(['b']);
    expect(specs(scanFiles(files, true))).toEqual(['@scope/forbidden', 'b']);
  });

  test('type-only imports stay edges (a real dependency) and are marked', () => {
    const edges = scanFiles({ 'src/t.ts': "import type { T } from './types';\nexport type { U } from './u';\n" });
    expect(edges.map((e) => [e.importSpecifier, e.typeOnly === true])).toEqual([
      ['./types', true],
      ['./u', true],
    ]);
  });

  test('scan.files lists every scanned source file, including import-free ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-files-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'empty.ts'), 'export const nothing = 0;\n');
      writeFileSync(join(root, 'src', 'one.ts'), "import a from 'a';\n");
      writeFileSync(join(root, 'package.json'), '{"name":"fx"}');
      const scan = scanImports({ projectRoot: root });
      expect([...(scan.files ?? [])].sort()).toEqual(['src/empty.ts', 'src/one.ts']);
      expect(scan.manifestFiles).toEqual(['package.json']);
      expect(scan.filesScanned).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('6.1a#line-numbers — every edge sits on its keyword line', () => {
  test('single-line, multi-line clause, side-effect, dynamic and require imports', () => {
    const edges = scanFiles({
      'src/x.ts': [
        "import a from 'a';", // 1
        'import {', // 2
        '  b,', // 3
        "} from 'b';", // 4
        "import './side';", // 5
        "const c = await import('c');", // 6
        "const d = require('d');", // 7
      ].join('\n'),
    });
    expect(edges.map((e) => [e.importSpecifier, e.line])).toEqual([
      ['a', 1],
      ['b', 2],
      ['./side', 5],
      ['c', 6],
      ['d', 7],
    ]);
  });
});

describe('6.1(b) — every import pattern stays linear on long blank runs', () => {
  const RUN = ' '.repeat(20_000);
  const BUDGET_MS = 250;
  /** Buffers shaped to trip adjacent whitespace quantifiers: keyword + 20K spaces + more. */
  const blankRunBuffers: Record<string, string> = {
    'import-then-clause': `import${RUN}{ a }${RUN}from 'x';\n`,
    'export-without-from': `export${RUN}const x = 1${RUN}\n`,
    'import-dangling': `import${RUN}x\n`,
    'side-effect': `import${RUN}'x';\n`,
    dynamic: `const m = import${RUN}(${RUN}'x'${RUN});\n`,
    require: `const r = require${RUN}(${RUN}'x'${RUN});\n`,
    'from-then-run': `import { a } from${RUN}\n`,
  };

  for (const [name, buffer] of Object.entries(blankRunBuffers)) {
    for (const zone of ['all', 'code'] as const) {
      test(`${name} (zone ${zone}) parses in under ${BUDGET_MS} ms`, () => {
        const start = performance.now();
        parseImportStatements(buffer, { zone });
        expect(performance.now() - start).toBeLessThan(BUDGET_MS);
      });
    }
  }

  test("shape A — an exported class with 320 JSDoc'd members — parses fast in both zones", () => {
    const body = Array.from({ length: 320 }, (_, i) => `  /** member ${i} documented at length here */ m${i}() { return ${i}; }`);
    const buffer = `import { dep } from 'dep';\nexport class Foo {\n${body.join('\n')}\n}\n`;
    for (const zone of ['all', 'code'] as const) {
      const start = performance.now();
      const parsed = parseImportStatements(buffer, { zone });
      expect(performance.now() - start).toBeLessThan(BUDGET_MS);
      expect(parsed.map((p) => p.specifier)).toEqual(['dep']);
    }
  });

  test('shape B — a 320-line JSDoc inside an import clause — parses fast and still finds the import', () => {
    const doc = Array.from({ length: 320 }, () => '   * a line of documentation for this binding').join('\n');
    const buffer = `import {\n  /**\n${doc}\n   */\n  a,\n} from 'x';\n`;
    const start = performance.now();
    const parsed = parseImportStatements(buffer, { zone: 'code' });
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    expect(parsed.map((p) => [p.specifier, p.line])).toEqual([['x', 1]]);
  });

  test('scanImports over every blank-run shape stays within budget (the old scan-imports IMPORT_RE path)', () => {
    const files: Record<string, string> = {};
    for (const [name, buffer] of Object.entries(blankRunBuffers)) files[`src/${name}.ts`] = buffer;
    const start = performance.now();
    scanFiles(files);
    expect(performance.now() - start).toBeLessThan(BUDGET_MS * Object.keys(files).length);
  });
});
