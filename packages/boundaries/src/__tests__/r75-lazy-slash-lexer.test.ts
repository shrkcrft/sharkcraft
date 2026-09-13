/**
 * r75 — the lexer judges a `/` LAZILY, with byte-identical zones (round 11
 * review PERF-2).
 *
 * Round 11's regex-literal support tracked the previous significant character
 * EAGERLY on every character, which made `lexCodeZones` ~1.8x slower under
 * every zoned plane and the import parser. The judgement now runs only for the
 * rare `/` that is not a comment, walking back over blanks and the recorded
 * zones. This lock proves it is the same function: the pre-fix EAGER lexer is
 * kept below as the reference, and both must produce identical zones over
 * adversarial snippets and a real corpus. (No wall-clock assertion — a timing
 * ratio is flaky on a loaded machine; the perf claim lives in the review's
 * bench.)
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  lexCodeZones,
  lexCodeZonesStats,
  resetLexCodeZonesStats,
  withLexCache,
  type ICodeZone,
} from '../extract/code-zones.ts';
import { skipComment, skipString } from '../extract/scan-literals.ts';

// ── the pre-fix EAGER lexer, verbatim (the reference) ─────────────────────

const REGEX_AFTER_PUNCTUATION: ReadonlySet<string> = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '<', '>', '~', '^', '/',
]);
const REGEX_AFTER_KEYWORD: ReadonlySet<string> = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'yield', 'await', 'instanceof', 'else', 'do',
]);
const isIdentifierChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);
const isBlank = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

function regexMayStartAfter(content: string, prev: number): boolean {
  if (prev < 0) return true;
  const ch = content[prev]!;
  if (REGEX_AFTER_PUNCTUATION.has(ch)) return true;
  if (!isIdentifierChar(ch)) return false;
  let start = prev;
  while (start > 0 && isIdentifierChar(content[start - 1])) start -= 1;
  if (start > 0 && content[start - 1] === '.') return false;
  return REGEX_AFTER_KEYWORD.has(content.slice(start, prev + 1));
}

function skipRegexLiteral(content: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < content.length; i += 1) {
    const c = content[i]!;
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') {
      const next = content[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return -1;
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '/') {
      let end = i;
      while (end + 1 < content.length && /[A-Za-z]/.test(content[end + 1]!)) end += 1;
      return end;
    }
  }
  return -1;
}

function eagerLex(content: string): ICodeZone[] {
  const zones: ICodeZone[] = [];
  let codeStart = 0;
  let prev = -1;
  let prevOperand = false;
  const flushCode = (upTo: number): void => {
    if (upTo > codeStart) zones.push({ kind: 'code', start: codeStart, end: upTo });
  };
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i]!;
    if (c === '"' || c === "'" || c === '`') {
      flushCode(i);
      const end = skipString(content, i);
      zones.push({ kind: 'string', start: i, end: end + 1, ...(c === '`' ? { template: true } : {}) });
      i = end;
      codeStart = i + 1;
      prev = end;
      prevOperand = true;
      continue;
    }
    if (c === '/') {
      const end = skipComment(content, i);
      if (end >= 0) {
        flushCode(i);
        zones.push({ kind: 'comment', start: i, end: end + 1 });
        i = end;
        codeStart = i + 1;
        continue;
      }
      if (!prevOperand && regexMayStartAfter(content, prev)) {
        const reEnd = skipRegexLiteral(content, i);
        if (reEnd >= 0) {
          flushCode(i);
          zones.push({ kind: 'code', start: i, end: reEnd + 1, regex: true });
          i = reEnd;
          codeStart = i + 1;
          prev = reEnd;
          prevOperand = true;
          continue;
        }
      }
    }
    if (!isBlank(c)) {
      prev = i;
      prevOperand = false;
    }
  }
  flushCode(content.length);
  return zones;
}

// ── the lock ────────────────────────────────────────────────────────────────

const ADVERSARIAL: readonly string[] = [
  '',
  '/',
  '//',
  '/re/',
  'a /* c */ / 2 /x/.test(y)',
  "'s' / 2; const r = /re/g;",
  '/re/ / 2',
  'obj.return / 2 / 3',
  'x = y\n/re/.test(z)',
  "const q = /`/g; import('./later')",
  'return /x/.test(s)',
  'a = b // c\n/d/.test(e)',
  'f(/[/]/, `t${1}`)',
  'x /= 2; y = /=/',
  'typeof /x/',
  '(a + b) / 2',
  'arr[0] / 2 / 3',
  'if (x) /re/.test(y)',
  'a = /* c */ /re/; b = c /* d */ / e',
  "`tpl` / 2; 'q' /re/ ; /a\\/b/g.exec(s)",
  '/*a*/ /*b*/ /re/',
  'x\n  // comment\n  /re/.test(y)',
  'case /x/: break',
  'const d = a\n/ b / c',
];

function corpus(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) corpus(abs, out);
    else if (name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

describe('lexCodeZones — lazy `/` judgement ≡ the eager reference', () => {
  test('adversarial regex / division / comment snippets: identical zones', () => {
    for (const s of ADVERSARIAL) expect({ s, zones: [...lexCodeZones(s)] }).toEqual({ s, zones: eagerLex(s) });
  });

  test('a real corpus (boundaries + core sources): identical zones for every file', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const files = [...corpus(join(root, 'boundaries', 'src')), ...corpus(join(root, 'core', 'src'))];
    expect(files.length).toBeGreaterThan(50);
    const mismatched = files.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return JSON.stringify(lexCodeZones(text)) !== JSON.stringify(eagerLex(text));
    });
    expect(mismatched).toEqual([]);
  });

  test('exact zones where it matters: a backtick in a regex literal opens nothing', () => {
    const src = "const q = /`/g; import('./later')";
    const zones = lexCodeZones(src);
    expect(zones.some((z) => z.kind === 'code' && z.regex === true && src.slice(z.start, z.end) === '/`/g')).toBe(true);
    expect(zones.some((z) => z.kind === 'string' && src.slice(z.start, z.end) === "'./later'")).toBe(true);
    expect(zones.some((z) => z.template === true)).toBe(false);
    expect(lexCodeZones('a / b / c').some((z) => z.regex === true)).toBe(false);
  });
});

describe('withLexCache — one lex per distinct content (PERF-1)', () => {
  test('inside a window equal contents share ONE frozen result; outside, every call lexes', () => {
    const src = "import { a } from './a'; // note\nconst r = /x/;\n";
    resetLexCodeZonesStats();
    const a = lexCodeZones(src);
    const b = lexCodeZones(src);
    expect(a).not.toBe(b);
    expect(lexCodeZonesStats()).toEqual({ lexed: 2, memoHits: 0 });

    resetLexCodeZonesStats();
    withLexCache(() => {
      const x = lexCodeZones(src);
      const y = lexCodeZones(`${src}`);
      expect(y).toBe(x);
      expect(Object.isFrozen(x)).toBe(true);
      // nested windows share the memo
      withLexCache(() => expect(lexCodeZones(src)).toBe(x));
    });
    expect(lexCodeZonesStats()).toEqual({ lexed: 1, memoHits: 2 });
    // closed: the memo is gone
    resetLexCodeZonesStats();
    lexCodeZones(src);
    expect(lexCodeZonesStats()).toEqual({ lexed: 1, memoHits: 0 });
  });
});
