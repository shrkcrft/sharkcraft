/**
 * Round 11 §6.1(b) — a pattern that is fast on real source can be O(run²) on a
 * zone-BLANKED buffer, where comments and strings become long whitespace runs.
 * That class is invisible to tests over ordinary source, so it is locked two
 * ways here:
 *
 *   1. runtime: every internal pattern that runs on a (possibly) blanked buffer
 *      finishes an exec-all over a synthetic 64 KiB multi-line blank run well
 *      inside 250 ms (quadratic is ~4.5 s on bun, ~7 s on node);
 *   2. statically: `findBlankRunHazards` finds nothing in each of them, and DOES
 *      flag the shapes that were measured to blow up — so the next pattern
 *      someone adds is caught from its text.
 *
 * Plus the user-pattern path: a hazardous `regex-capture` under `scan: 'code'`
 * earns a hint and is bounded — a file over budget is a named error, never a
 * silent partial.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractTokens, extractorHeadPatterns } from '../extract/extract-tokens.ts';
import { findBlankRunHazards } from '../util/blank-run-hazard.ts';
import { collectSinkBindings, LOCAL_DECL } from '../wiring/sink-imports.ts';

/** code prefix + a 64 KiB blank run (spaces, a newline every 80 chars) + code suffix. */
function blankRunBuffer(): string {
  const line = ' '.repeat(79) + '\n';
  const run = line.repeat(Math.ceil((64 * 1024) / line.length));
  return `export const a = [1];\nfunction f() { return 1; }\n${run}export const b = 2;\n`;
}

function execAllMs(re: RegExp, text: string): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const started = performance.now();
  g.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (m.index === g.lastIndex) g.lastIndex += 1;
  }
  return performance.now() - started;
}

const HEADS = extractorHeadPatterns('X');
const INTERNAL: ReadonlyArray<readonly [string, RegExp]> = [
  ['head: array literal', HEADS.arrayLiteral],
  ['head: object literal', HEADS.objectLiteral],
  ['head: enum body', HEADS.enumBody],
  ['head: call', HEADS.call],
  ['head: decorator', HEADS.decorator],
  ['head: string union', HEADS.stringUnion],
  ['export declaration', HEADS.exportDecl],
  ['export clause', HEADS.exportClause],
  ['sink LOCAL_DECL', LOCAL_DECL],
];

describe('internal patterns stay linear on a blanked buffer', () => {
  const buffer = blankRunBuffer();
  for (const [label, re] of INTERNAL) {
    test(`${label}: exec-all over a 64 KiB blank run < 250 ms`, () => {
      expect({ label, fast: execAllMs(re, buffer) < 250 }).toEqual({ label, fast: true });
    });
    test(`${label}: no blank-run hazard in its source`, () => {
      expect({ label, hazards: findBlankRunHazards(re.source) }).toEqual({ label, hazards: [] });
    });
  }
});

describe('findBlankRunHazards flags the shapes that were measured to blow up', () => {
  test('the OLD remover lookup: a leading `\\s*` after an optional group', () => {
    const old =
      '(?:export\\s+)?(?:async\\s+)?function\\s+removeFoo\\s*\\(|\\bremoveFoo\\s*=\\s*\\(|(?:public|private|protected)?\\s*(?:async\\s+)?removeFoo\\s*\\(';
    const hazards = findBlankRunHazards(old);
    expect(hazards.some((h) => h.shape === 'leading')).toBe(true);
  });

  test('the OLD import statement: a lazy class touching `\\s+` / `\\s*`', () => {
    const old = `\\b(import|export)\\s+([^;'"]*?)\\s*from\\s*['"]([^'"]+)['"]\\s*;?`;
    expect(findBlankRunHazards(old).some((h) => h.shape === 'adjacent')).toBe(true);
  });

  test('`\\s*(?:<x>)?\\s*=` — two whitespace quantifiers around an optional group', () => {
    expect(findBlankRunHazards('\\btype\\s+X\\s*(?:<[^>]*>)?\\s*=').some((h) => h.shape === 'adjacent')).toBe(true);
  });

  test('the OLD method-declaration pattern: `[\\t ]*` touching `\\s*`', () => {
    const old = '(?:^|\\n)[\\t ]*\\s*(?:static\\s+)?(?:async\\s+)?(register[A-Z]\\w*)\\s*\\(';
    expect(findBlankRunHazards(old).length).toBeGreaterThan(0);
  });

  test('the OLD sink LOCAL_DECL: a newline-spanning `\\s*` from every line start', () => {
    const old =
      '(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:const|let|var|function\\s*\\*?|class|enum|interface|type)\\s+([A-Za-z_$][\\w$]*)';
    expect(findBlankRunHazards(old).some((h) => h.shape === 'leading')).toBe(true);
  });

  test('a user pattern from the audit: `\\s*(?:async\\s+)?removeHandler\\s*\\(`', () => {
    expect(findBlankRunHazards('\\s*(?:async\\s+)?removeHandler\\s*\\(').length).toBeGreaterThan(0);
  });

  test('`(?:\\s)+` is judged as the `\\s+` it is', () => {
    expect(findBlankRunHazards('(?:\\s)+foo').some((h) => h.shape === 'leading')).toBe(true);
  });

  test('does NOT flag line-bounded or literal-anchored shapes', () => {
    for (const ok of [
      '(?:^|\\n)[ \\t]*(?:(?:public|private|protected)[ \\t]+)?(register[A-Z]\\w*)[ \\t]*\\(',
      '\\bexport\\s+(?:declare\\s+)?(?:const|let)\\s+([A-Za-z_$][\\w$]*)',
      '\\b([A-Za-z_$][\\w$]*)\\s*(?:=\\s*)?\\(',
      'registerHandler\\(\\s*([A-Za-z]+)',
      '@Inject\\(\\s*([A-Z_]+)\\s*\\)',
      "id:\\s*'([^']+)'",
    ]) {
      expect({ ok, hazards: findBlankRunHazards(ok) }).toEqual({ ok, hazards: [] });
    }
  });
});

describe('the sink LOCAL_DECL rewrite binds the same names on real source', () => {
  // The frozen pre-round-11 pattern — the reference the rewrite must equal.
  const OLD_LOCAL_DECL =
    /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:const|let|var|function\s*\*?|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g;

  function sourceFiles(): string[] {
    const root = resolve(import.meta.dir, '../../..');
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts')) out.push(p);
      }
    };
    for (const pkg of readdirSync(root)) {
      const src = join(root, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // a package without src/
      }
    }
    return out;
  }

  test('old ≡ new over every .ts file under packages/*/src', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    const diffs: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      const oldNames = [...content.matchAll(OLD_LOCAL_DECL)].map((m) => m[1]);
      const newNames = collectSinkBindings(content)
        .filter((b) => b.kind === 'local')
        .map((b) => b.local);
      if (oldNames.join(',') !== newNames.join(',')) diffs.push(f);
    }
    expect(diffs).toEqual([]);
  });
});

describe('a zoned user pattern is linted and bounded', () => {
  const docComment = '/**\n' + ' * lorem ipsum dolor sit amet consectetur adipiscing elit sed do\n'.repeat(400) + ' */\n';
  const file = { path: 'src/big.ts', content: `${docComment}export function registerHandler(h) { return h; }\n` };

  test('a hazardous pattern under scan: code earns the hazard hint', () => {
    const res = extractTokens(
      { files: ['src/**'], extract: 'regex-capture', pattern: '(registerHandler)\\s*\\(', scan: 'code' },
      [{ path: 'src/a.ts', content: 'registerHandler(1);\n' }],
    );
    // Linear pattern (literal-anchored) → no hint, one site.
    expect(res.hint).toBeUndefined();
    expect(res.sites.map((s) => s.token)).toEqual(['registerHandler']);
    const bad = extractTokens(
      { files: ['src/**'], extract: 'regex-capture', pattern: '\\s*(?:async\\s+)?(registerHandler)\\s*\\(', scan: 'code' },
      [{ path: 'src/a.ts', content: 'registerHandler(1);\n' }],
    );
    expect(bad.hint).toContain('backtracking hazard');
  });

  test('over a 400-line doc comment a NEWLINE-CROSSING lead is skipped before it runs — named, never a silent partial', () => {
    const started = performance.now();
    const res = extractTokens(
      { files: ['src/**'], extract: 'regex-capture', pattern: '\\s*(?:async\\s+)?(removeHandler)\\s*\\(', scan: 'code' },
      [file],
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
    expect(res.sites).toEqual([]);
    expect(res.error).toContain('skipped 1 file(s): over budget');
    expect(res.error).toContain('src/big.ts');
    // Worded as a PREDICTION — nothing ran, so no time was spent.
    expect(res.error).toContain('predicted over budget, so the regex was never run');
    expect(res.error).toContain('Σ run²');
    expect(res.error).not.toContain('ran past');
    expect(res.hint).toContain('backtracking hazard');
  });

  test('the same hazardous pattern on RAW text (scan: all) is neither linted nor capped', () => {
    const res = extractTokens(
      { files: ['src/**'], extract: 'regex-capture', pattern: '\\s*(?:async\\s+)?(registerHandler)\\s*\\(' },
      [file],
    );
    expect(res.error).toBeUndefined();
    expect(res.hint).toBeUndefined();
    expect(res.sites.map((s) => s.token)).toEqual(['registerHandler']);
  });
});

describe('a flagged but LINE-BOUNDED hazard is priced per line, not per run (round-11 review #1)', () => {
  const docComment = '/**\n' + ' * lorem ipsum dolor sit amet consectetur adipiscing elit sed do\n'.repeat(400) + ' */\n';
  const big = (tail: string): { path: string; content: string } => ({
    path: 'src/big.ts',
    content: `${docComment}${tail}\n`,
  });

  // Each is a real hazard (O(line²) per blanked line) and earns the hint, but
  // it stops at every newline: a 400-line doc costs Σ line² ≈ 1.7e6, not the
  // (26 KB run)² ≈ 7e8 that used to get the file skipped (and a passing
  // wiring rule reported FAILED).
  for (const pattern of [
    '[ \\t]*(?:async[ \\t]+)?(removeHandler)[ \\t]*\\(',
    '.*?(removeHandler)\\(',
    '[ ]*(removeHandler)\\(',
    '[ \\t]*(removeHandler)\\(',
  ]) {
    test(`${pattern}: hinted, and it still scans the file — its site, no error`, () => {
      const started = performance.now();
      const res = extractTokens({ files: ['src/**'], extract: 'regex-capture', pattern, scan: 'code' }, [
        big('export function f() { removeHandler(h); }'),
      ]);
      expect({ pattern, error: res.error }).toEqual({ pattern, error: undefined });
      expect(res.sites.map((s) => s.token)).toEqual(['removeHandler']);
      expect(res.hint).toContain('backtracking hazard');
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }

  test('a line-start-only `\\s*` lead is priced lines × run: it scans the same doc', () => {
    const res = extractTokens(
      { files: ['src/**'], extract: 'regex-capture', pattern: '(?:^|\\n)\\s*(removeHandler)\\(', scan: 'code' },
      [big('  removeHandler(h);')],
    );
    expect(res.error).toBeUndefined();
    expect(res.sites.map((s) => s.token)).toEqual(['removeHandler']);
  });

  test('a newline-crossing lead over the same doc stays skipped — the prediction still bounds it', () => {
    const res = extractTokens(
      { files: ['src/**'], extract: 'regex-capture', pattern: '\\s*(?:async\\s+)?(x)\\s*\\(', scan: 'code' },
      [big('export function f() { x(h); }')],
    );
    expect(res.sites).toEqual([]);
    expect(res.error).toContain('predicted over budget');
  });

  test('one very long blanked LINE is still skipped for a line-bounded lead (Σ line-run² is a real bound)', () => {
    // A 20 000-char string blanked under scan: 'code' → one 20 KB space-only line.
    const res = extractTokens(
      { files: ['src/**'], extract: 'regex-capture', pattern: '[ \\t]*(removeHandler)\\(', scan: 'code' },
      [{ path: 'src/min.ts', content: `const s = '${'a'.repeat(20_000)}'; removeHandler(h);\n` }],
    );
    expect(res.sites).toEqual([]);
    expect(res.error).toContain('Σ line-run²');
  });

  test('the leading-hazard hint says to anchor on a literal — never to use another leading quantifier', () => {
    const res = extractTokens(
      { files: ['src/**'], extract: 'regex-capture', pattern: '[ \\t]*(useThing)\\(', scan: 'code' },
      [{ path: 'src/a.ts', content: 'useThing(1);\n' }],
    );
    expect(res.hint).toContain('anchor the alternative on a literal');
    expect(res.hint).not.toContain('use [ \\t]* for same-line whitespace');
    expect(res.hint).toContain('stops at each newline');
  });
});

describe("findBlankRunHazards carries each hazard's reach", () => {
  test('`\\s*foo` crosses newlines; `[ \\t]*foo`, `[ ]*foo` and `.*?foo` do not', () => {
    expect(findBlankRunHazards('\\s*foo').map((h) => h.crossesNewline)).toEqual([true]);
    for (const p of ['[ \\t]*foo', '[ ]*foo', '.*?foo']) {
      expect({ p, reach: findBlankRunHazards(p).map((h) => h.crossesNewline) }).toEqual({ p, reach: [false] });
    }
  });

  test('an adjacent pair overlapping only on spaces is line-bounded; overlapping on newlines it is not', () => {
    const adjacent = (p: string): boolean[] =>
      findBlankRunHazards(p)
        .filter((h) => h.shape === 'adjacent')
        .map((h) => h.crossesNewline);
    expect(adjacent('\\btype\\s+X\\s*(?:<[^>]*>)?[ \\t]*=')).toEqual([false]);
    expect(adjacent('\\btype\\s+X\\s*(?:<[^>]*>)?\\s*=')).toEqual([true]);
  });

  test('a newline-crossing lead that can only start at a line start is marked fromLineStart', () => {
    expect(findBlankRunHazards('(?:^|\\n)\\s*foo')).toMatchObject([
      { shape: 'leading', crossesNewline: true, fromLineStart: true },
    ]);
  });
});
