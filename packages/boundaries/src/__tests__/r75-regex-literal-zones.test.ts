/**
 * Round 11 review — a regex literal is OPAQUE to the code-zone lexer.
 *
 * The default code-zone import scan missed real imports that FOLLOW a regex
 * literal holding a backtick (`` /`/g ``) or a `/*` (`/\/*$/`): the lexer did
 * not know regex literals, so the backtick opened a template literal and the
 * `/*` a block comment, each running to the next backtick / `*\/` in the file,
 * and `parseImportStatements` (zone `code`) dropped every `import()` /
 * `require()` inside those phantom zones — so every boundary surface passed
 * over a forbidden import. The `` /`/g `` shape already occurs in five files of
 * this repo.
 *
 * Also locked here: the RAW reading's import clause never crosses a backtick
 * (line parity with the pre-round-11 scanImports regex), and `import-edges`
 * reports what its zone blanked.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IWiringSource } from '@shrkcrft/core';
import {
  extractTokens,
  lexCodeZones,
  parseImportStatements,
  scanImports,
  zoneAt,
  type IImportEdge,
} from '../index.ts';

function scanFiles(files: Record<string, string>): IImportEdge[] {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-regex-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    }
    return scanImports({ projectRoot: root }).edges;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The reviewer's two fixture files, verbatim. */
const ESC = [
  "export function esc(s: string): string { return s.replace(/`/g, ''); }",
  "export async function load() { return import('@scope/forbidden'); }",
].join('\n');
const TRIM = [
  "export const trim = (s: string): string => s.replace(/\\/*$/, '');",
  "export const lazy = () => require('@scope/forbidden/lazy');",
  '/** trailing doc */',
].join('\n');

const regexSpans = (src: string): string[] =>
  lexCodeZones(src)
    .filter((z) => z.regex === true)
    .map((z) => src.slice(z.start, z.end));

describe('a regex literal cannot open a template literal or a block comment', () => {
  test('an import() after /`/g and a require() after /\\/*$/ are edges, on their keyword lines', () => {
    const edges = scanFiles({ 'src/esc.ts': ESC, 'src/trim.ts': TRIM });
    expect(edges.map((e) => `${e.from}:${e.line} ${e.importSpecifier}`).sort()).toEqual([
      'src/esc.ts:2 @scope/forbidden',
      'src/trim.ts:2 @scope/forbidden/lazy',
    ]);
  });

  test('parity: on those shapes the code zone equals the raw reading (neither holds a comment- or string-only import)', () => {
    const key = (p: { kind: string; specifier: string; line: number }): string => `${p.kind} ${p.specifier} ${p.line}`;
    for (const body of [ESC, TRIM]) {
      expect(parseImportStatements(body).map(key)).toEqual(parseImportStatements(body, { zone: 'all' }).map(key));
    }
  });

  test('parity: the code zone is the raw set MINUS the comment- and regex-only forms', () => {
    const body = [
      "const r = s.replace(/\\/*x/, '');",
      "// import('@scope/commented');",
      "const re = /require('@scope/in-regex')/;",
      "import b from 'b';",
    ].join('\n');
    expect(parseImportStatements(body).map((p) => p.specifier)).toEqual(['b']);
    // The raw reading (the escape hatch) still sees every text form.
    expect(parseImportStatements(body, { zone: 'all' }).map((p) => p.specifier).sort()).toEqual([
      '@scope/commented',
      '@scope/in-regex',
      'b',
    ]);
  });

  test('the lexer tags the regex span as code; a real template literal and comment after it still lex', () => {
    const src = "const a = s.replace(/`/g, '');\nconst t = `x`; // c\n";
    const zones = lexCodeZones(src);
    expect(regexSpans(src)).toEqual(['/`/g']);
    expect(zones.find((z) => z.regex === true)?.kind).toBe('code');
    expect(zoneAt(zones, src.indexOf('`x`'))).toBe('string');
    expect(zoneAt(zones, src.indexOf('// c'))).toBe('comment');
  });

  test('a division is not a regex literal: `a / b / c` and `(n + 1) / 2` stay plain code', () => {
    const src = "const r = a / b / c; const s = 'x'; const q = (n + 1) / 2; /* real */";
    const zones = lexCodeZones(src);
    expect(regexSpans(src)).toEqual([]);
    expect(zoneAt(zones, src.indexOf("'x'"))).toBe('string');
    expect(zoneAt(zones, src.indexOf('/* real */'))).toBe('comment');
  });

  test('keyword position: `return /`/` is a regex, `obj.return / 2 / 1` is a division', () => {
    const src = 'function f(s) { return /`/.test(s); }\nconst d = obj.return / 2 / 1;\nconst t = `tpl`;';
    expect(regexSpans(src)).toEqual(['/`/']);
    expect(zoneAt(lexCodeZones(src), src.indexOf('`tpl`'))).toBe('string');
  });

  test('a `/` inside a character class does not close the literal; flags belong to it', () => {
    const src = 'const r = /[/`]+/g;\nconst t = `tpl`;';
    expect(regexSpans(src)).toEqual(['/[/`]+/g']);
    expect(zoneAt(lexCodeZones(src), src.indexOf('`tpl`'))).toBe('string');
  });

  test('a `/` with no closing slash on its line is not a regex (bounded to the line)', () => {
    const src = 'const x = a++ / 2;\nconst t = `tpl`;';
    expect(regexSpans(src)).toEqual([]);
    expect(zoneAt(lexCodeZones(src), src.indexOf('`tpl`'))).toBe('string');
  });
});

describe('raw mode: an import clause never crosses a backtick', () => {
  /** The pre-round-11 scanImports static-import regex, verbatim — the raw-mode line oracle. */
  const OLD_SCAN_IMPORTS_RE = /(?:^|\s)(?:import|export)\s+[^'"`]*?from\s+['"]([^'"`]+)['"]/g;
  /** The shape of packages/importer/src/emit/synthesize-populated.ts: a backtick-quoted `shrk import …` in a doc comment. */
  const CORPUS = [
    '/**',
    ' * Populate the knowledge files — `shrk import <format> --populate`.',
    ' * Usage: `import x` is documented elsewhere.',
    ' */',
    "import { a } from '@shrkcrft/knowledge';",
    'import {',
    '  b,',
    '  c,',
    "} from './local';",
    "export { d } from './d';",
    "import type { T } from './types';",
    '',
  ].join('\n');

  test("a doc comment's `shrk import …` no longer claims the next real import", () => {
    const raw = parseImportStatements(CORPUS, { zone: 'all' });
    expect(raw.find((p) => p.specifier === '@shrkcrft/knowledge')?.line).toBe(5);
    expect(parseImportStatements(CORPUS).find((p) => p.specifier === '@shrkcrft/knowledge')?.line).toBe(5);
  });

  test('every static import the old scanImports regex saw sits on the same (keyword) line in raw mode', () => {
    const old: string[] = [];
    OLD_SCAN_IMPORTS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OLD_SCAN_IMPORTS_RE.exec(CORPUS)) !== null) {
      // The old regex consumed the whitespace BEFORE the keyword (its line
      // off-by-one); judge it at the keyword itself.
      const keyword = m.index + (/^\s*/.exec(m[0])?.[0].length ?? 0);
      old.push(`${m[1]} ${CORPUS.slice(0, keyword).split('\n').length}`);
    }
    const now = parseImportStatements(CORPUS, { zone: 'all' })
      .filter((p) => p.kind === 'import' || p.kind === 'reexport')
      .map((p) => `${p.specifier} ${p.line}`);
    expect(old.length).toBe(4);
    expect(now).toEqual(old);
  });
});

describe('import-edges reports what its zone blanked', () => {
  const content = "// import { z } from '@x/zz';\nimport { a } from '@x/a';\n";
  const source = (scan: 'code' | 'all'): IWiringSource =>
    ({ files: ['src/**'], extract: 'import-edges', emit: 'edge', to: { modulePattern: '^@x/' }, scan }) as IWiringSource;

  test('scan: code drops the commented edge AND says how many characters it blanked', () => {
    const r = extractTokens(source('code'), [{ path: 'src/a.ts', content }]);
    expect(r.error).toBeUndefined();
    expect(r.sites.map((s) => s.token)).toEqual(['src/a.ts → a']);
    expect(r.blankedChars).toBe("// import { z } from '@x/zz';".length);
  });

  test('scan: all reads raw text — the commented edge counts and no zone figure is attached', () => {
    const r = extractTokens(source('all'), [{ path: 'src/a.ts', content }]);
    expect(r.sites.map((s) => s.token).sort()).toEqual(['src/a.ts → a', 'src/a.ts → z']);
    expect(r.blankedChars).toBeUndefined();
  });
});
