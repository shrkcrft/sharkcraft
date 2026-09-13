/**
 * Round 11 — ONE answer to "what does this file import".
 *
 * `scanImports` (the boundary plane) and the `import-edges` DSL extractor both
 * read through `parseImportStatements`. Before round 11 they disagreed (four
 * private regexes vs the parser), and the round-10 `scan: 'code'` zone turned an
 * `import-edges` rule VACUOUS: it blanked every specifier (a string) before the
 * extractor ran and silently extracted nothing.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWiringSource, type IWiringSource } from '@shrkcrft/core';
import { extractTokens, parseImportStatements, scanImports } from '../index.ts';

const FILES: Record<string, string> = {
  'src/commented.ts': "// import { z } from '@x/zz';\nimport { a } from '@x/a';\n",
  'src/phantom.ts': "export const ok = 1;\n// … copied from '@x/phantom' long ago\n",
  'src/missed.ts': "const q = 1;\nimport {\n  real, // don't use it\n} from '@x/real';\n",
  'src/multi.ts': [
    "import d from '@x/d';",
    "export { e } from '@x/e';",
    "import '@x/side';",
    "const f = await import('@x/f');",
    "const g = require('@x/g');",
    "const s = \"import h from '@x/h'\";",
  ].join('\n'),
  'src/esc.ts': "export const esc = (s: string) => s.replace(/[&<>\"']/g, '');\nexport const later = () => import('@x/late');\n",
};

function withWorkspace<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-parity-'));
  try {
    for (const [rel, body] of Object.entries(FILES)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const entries = Object.entries(FILES).map(([path, content]) => ({ path, content }));

describe('scanImports ≡ parseImportStatements (code zone), file by file', () => {
  test('specifier and line agree for every fixture file', () => {
    withWorkspace((root) => {
      const scan = scanImports({ projectRoot: root });
      for (const { path, content } of entries) {
        const fromScan = scan.edges
          .filter((e) => e.from === path)
          .map((e) => `${e.importSpecifier}@${e.line}`)
          .sort();
        const fromParser = parseImportStatements(content, { zone: 'code' })
          .map((p) => `${p.specifier}@${p.line}`)
          .sort();
        expect({ path, edges: fromScan }).toEqual({ path, edges: fromParser });
      }
    });
  });
});

describe('import-edges — scan zones judge the statement, never erase it', () => {
  const base: IWiringSource = {
    files: ['src/**'],
    extract: 'import-edges',
    emit: 'edge',
    to: { modulePattern: '^@x/' },
  };
  const tokens = (source: IWiringSource): string[] =>
    [...extractTokens(source, entries).sites.map((s) => s.token)].sort();

  test("scan: 'code' ≡ scan unset — neither includes the commented or string-literal import", () => {
    const unset = tokens(base);
    const code = tokens({ ...base, scan: 'code' });
    expect(code).toEqual(unset);
    expect(code.length).toBeGreaterThan(0);
    expect(code.join(' ')).not.toContain('zz');
    expect(code.join(' ')).not.toContain('@x/h');
    expect(code.join(' ')).not.toContain('phantom');
    // The import the old clause class missed is found.
    expect(code).toContain('src/missed.ts → real');
  });

  test("scan: 'code-and-templates' reads code too (never the vacuous empty set)", () => {
    expect(tokens({ ...base, scan: 'code-and-templates' })).toEqual(tokens(base));
  });

  test("scan: 'all' is the raw escape hatch — the commented import counts again", () => {
    expect(tokens({ ...base, scan: 'all' })).toContain('src/commented.ts → z');
  });

  test('the import-edges statement set ≡ scanImports edges for the same files (file:line)', () => {
    withWorkspace((root) => {
      const fromExtractor = new Set(
        extractTokens({ ...base, emit: 'from', to: { modulePattern: '.' } }, entries).sites.map(
          (s) => `${s.file}:${s.line}`,
        ),
      );
      const fromScan = new Set(scanImports({ projectRoot: root }).edges.map((e) => `${e.from}:${e.line}`));
      expect([...fromExtractor].sort()).toEqual([...fromScan].sort());
    });
  });

  test("scan: 'strings' and 'comments' on import-edges fail validation (an import is code)", () => {
    for (const scan of ['strings', 'comments'] as const) {
      const error = validateWiringSource({ ...base, scan });
      expect(error).toBeDefined();
      expect(error).toContain('import-edges');
    }
    expect(validateWiringSource({ ...base, scan: 'code' })).toBeUndefined();
    expect(validateWiringSource({ ...base, scan: 'all' })).toBeUndefined();
  });
});
