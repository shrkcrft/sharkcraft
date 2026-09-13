/**
 * r78 — round 15 follow-up (F6): THE frontmatter parser serves every reader.
 *
 * Decision records and Cursor `.mdc` rules had their own line splitters; they
 * now read through `splitFrontmatter` + `parseFrontmatter`. What they needed
 * became parser OPTIONS and one delimiter split — never a second parser:
 *
 *   - `FrontmatterScalarMode.Text` — an unquoted value is its text, verbatim
 *     (`0001`, `true`, `null`, `Fix #12` stay as written), the way both old
 *     splitters read values; a wholly quoted value is still unquoted, and one
 *     that merely starts and ends with a quote (`"a" and "b"`) stays text;
 *   - `splitFrontmatter` — BOM / CRLF normalised, `--- ` accepted, a `---`
 *     line at column 0 closes, an unterminated block is "no frontmatter" and
 *     says so;
 *   - `formatFrontmatterScalar` — the writer's inverse, decided by the parser
 *     itself, so a value always reads back as written.
 *
 * The default (`Typed`) reading is unchanged — r78-frontmatter-parser and the
 * spec / Markdown-knowledge tests hold it.
 */
import { describe, expect, test } from 'bun:test';
import {
  formatFrontmatterScalar,
  FrontmatterScalarMode,
  parseFrontmatter,
  parseInlineScalar,
  splitFrontmatter,
} from '../index.ts';

const TEXT = { scalars: FrontmatterScalarMode.Text } as const;

function text(raw: string): Readonly<Record<string, unknown>> {
  const r = parseFrontmatter(raw, TEXT);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function typed(raw: string): Readonly<Record<string, unknown>> {
  const r = parseFrontmatter(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('r78 FrontmatterScalarMode.Text — an unquoted value is its text', () => {
  test('no typing: numbers, booleans and null stay as written', () => {
    const raw = ['id: 0001', 'ratio: 1.50', 'on: true', 'nothing: null', 'tilde: ~', 'year: 2024'].join('\n');
    expect(text(raw)).toEqual({ id: '0001', ratio: '1.50', on: 'true', nothing: 'null', tilde: '~', year: '2024' });
    // The default reading is YAML's, unchanged.
    expect(typed(raw)).toEqual({ id: 1, ratio: 1.5, on: true, nothing: null, tilde: null, year: 2024 });
  });

  test('no trailing-comment strip: `Fix #12` keeps its #12', () => {
    expect(text('title: Fix #12 regression')['title']).toBe('Fix #12 regression');
    expect(typed('title: Fix #12 regression')['title']).toBe('Fix');
  });

  test('a wholly quoted value is unquoted (escapes undone); `"a" and "b"` is text', () => {
    expect(text('t: "Use \\"bun\\" only"')['t']).toBe('Use "bun" only');
    expect(text("t: 'Single quoted'")['t']).toBe('Single quoted');
    expect(text("t: 'It''s'")['t']).toBe("It''s");
    expect(text('t: "a" and "b"')['t']).toBe('"a" and "b"');
    expect(text('t: "*.ts", "*.tsx"')['t']).toBe('"*.ts", "*.tsx"');
    expect(text('t: ""')['t']).toBe('');
  });

  test('an empty value is absent (null) in both modes — structure, not text', () => {
    expect(text(['a:', 'b: x'].join('\n'))).toEqual({ a: null, b: 'x' });
  });

  test('the grammar is the same: inline lists, block lists, maps, block scalars', () => {
    expect(text('globs: ["src/**/*.{ts,tsx}", 0001]')['globs']).toEqual(['src/**/*.{ts,tsx}', '0001']);
    expect(text(['globs:', '  - "**/*.ts"', '  - src/**'].join('\n'))['globs']).toEqual(['**/*.ts', 'src/**']);
    expect(text(['related:', '  id: x', '  n: 7'].join('\n'))['related']).toEqual({ id: 'x', n: '7' });
    expect(text(['d: |', '  multi', '  line'].join('\n'))['d']).toBe('multi\nline');
    // An indented line still never sets a top-level field.
    expect(text(['id: top', 'related:', '  id: inner'].join('\n'))['id']).toBe('top');
  });

  test('out-of-grammar input is still an error naming the line — Text is a reading, not a tolerance', () => {
    for (const raw of [['id: x', 'just some text'].join('\n'), ['id: x', 'always apply: true'].join('\n')]) {
      const r = parseFrontmatter(raw, { ...TEXT, lineOffset: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('line 3');
    }
  });

  test('parseInlineScalar takes the same option (the comma-separated list reading)', () => {
    const r = parseInlineScalar('[*.ts, "a, b", src/**/*.{ts,tsx}, 0001]', 1, TEXT);
    expect(r.ok && r.value).toEqual(['*.ts', 'a, b', 'src/**/*.{ts,tsx}', '0001']);
  });

  test('only a value whose opening [ closes at its end is a flow list — `[RFC] Adopt [Bun]` is text (review fix)', () => {
    // It read as the one-item list ["RFC] Adopt [Bun"], so a decision titled so was REJECTED and an .mdc description dropped.
    expect(text('t: [RFC] Adopt [Bun]')['t']).toBe('[RFC] Adopt [Bun]');
    expect(text('t: [a] and [b]')['t']).toBe('[a] and [b]');
    expect(text('t: [a, b]')['t']).toEqual(['a', 'b']);
    expect(text('t: ["x]", y]')['t']).toEqual(['x]', 'y']);
    expect(text('t: [WIP]')['t']).toEqual(['WIP']);
    expect(formatFrontmatterScalar('[RFC] Adopt [Bun]', TEXT)).toBe('[RFC] Adopt [Bun]');
  });
});

describe('r78 IParseFrontmatterOptions.keys — a key nobody reads is never parsed (review fix)', () => {
  // Valid YAML the parser does not speak, all under keys a decision record never reads.
  const RAW = [
    'id: 0002-kafka',
    'summary: We will use Kafka',
    '  for messaging.',
    'decision makers: Alice',
    'meta:',
    '  a:',
    '    b: c',
    'tags:',
    '- x',
    'title: Use Kafka',
  ].join('\n');

  test('without keys the unread YAML fails the whole parse; with keys only the named keys are read', () => {
    expect(parseFrontmatter(RAW, TEXT).ok).toBe(false);
    const r = parseFrontmatter(RAW, { ...TEXT, keys: ['id', 'title'] });
    expect(r.ok && r.value).toEqual({ id: '0002-kafka', title: 'Use Kafka' });
    // Not a Text-mode feature — the Typed reading takes it too.
    const t = parseFrontmatter(RAW, { keys: ['id', 'title', 'tags'] });
    expect(t.ok && t.value).toEqual({ id: '0002-kafka', tags: ['x'], title: 'Use Kafka' });
  });

  test('an error under a key that IS read still fails, naming the file line', () => {
    const r = parseFrontmatter(['id: x', 'title: A long', '  wrapped title'].join('\n'), { ...TEXT, lineOffset: 1, keys: ['id', 'title'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('line 4');
  });

  test('a line naming no key is still an error; keys: [] checks that top-level structure alone', () => {
    const stray = ['id: x', 'just some text'].join('\n');
    expect(parseFrontmatter(stray, { ...TEXT, keys: ['id'] }).ok).toBe(false);
    expect(parseFrontmatter(stray, { ...TEXT, keys: [] }).ok).toBe(false);
    const clean = parseFrontmatter(RAW, { ...TEXT, keys: [] });
    expect(clean.ok && clean.value).toEqual({});
  });

  test('an unread block scalar and compact sequence are skipped whole — the next key still reads', () => {
    const r = parseFrontmatter(['notes: |', '  a', '', '  b', 'list:', '- one', '- two', 'id: after'].join('\n'), { ...TEXT, keys: ['id'] });
    expect(r.ok && r.value).toEqual({ id: 'after' });
  });
});

describe('r78 splitFrontmatter — THE delimiter split', () => {
  test('a plain document', () => {
    expect(splitFrontmatter('---\nid: a\n---\n# Body\n')).toEqual({
      frontmatter: 'id: a',
      body: '# Body\n',
      lineOffset: 1,
      unterminated: false,
    });
  });

  test('CRLF, a BOM and trailing whitespace on a delimiter are the same document', () => {
    const want = splitFrontmatter('---\nid: a\n---\nbody');
    expect(splitFrontmatter('---\r\nid: a\r\n---\r\nbody')).toEqual(want);
    expect(splitFrontmatter('\uFEFF---\nid: a\n---\nbody')).toEqual(want);
    expect(splitFrontmatter('--- \nid: a\n---  \nbody')).toEqual(want);
  });

  test('an empty block is empty frontmatter, not "no frontmatter"', () => {
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ frontmatter: '', body: 'body', lineOffset: 1, unterminated: false });
  });

  test('only a `---` line at column 0 closes — not `---x`, not an indented `---`', () => {
    const r = splitFrontmatter('---\nd: |\n  ---\nid: a\n---x\n---\nbody');
    expect(r.frontmatter).toBe('d: |\n  ---\nid: a\n---x');
    expect(r.body).toBe('body');
  });

  test('no opening line: the whole document is the body', () => {
    expect(splitFrontmatter('# Title\n---\n')).toEqual({ frontmatter: undefined, body: '# Title\n---\n', lineOffset: 0, unterminated: false });
  });

  test('an unterminated block is no frontmatter — and says so', () => {
    expect(splitFrontmatter('---\nid: a\nbody')).toEqual({
      frontmatter: undefined,
      body: '---\nid: a\nbody',
      lineOffset: 0,
      unterminated: true,
    });
  });
});

describe('r78 formatFrontmatterScalar — the writer\'s inverse, decided by THE parser', () => {
  const VALUES = [
    'Plain title',
    'Fix #12 regression',
    '0012',
    '"Quoted"',
    '[WIP]',
    'Title: with colon',
    'true',
    "It's fine",
    'null',
    '~',
    '- dash start',
    'a # b',
    'Trailing colon:',
    '|',
    '>-',
    '',
    '  padded  ',
    'line\nbreak',
    'tab\there',
    'back\\slash "q"',
    '# leading hash',
  ];

  for (const mode of [FrontmatterScalarMode.Text, FrontmatterScalarMode.Typed]) {
    test(`every value reads back as written (${mode})`, () => {
      for (const v of VALUES) {
        const line = `k: ${formatFrontmatterScalar(v, { scalars: mode })}`;
        const r = parseFrontmatter(line, { scalars: mode });
        expect({ v, line, back: r.ok ? r.value['k'] : r.error.message }).toEqual({ v, line, back: v });
      }
    });
  }

  test('a value that already reads back stays bare (so drafts look as before)', () => {
    expect(formatFrontmatterScalar('0002-test', TEXT)).toBe('0002-test');
    expect(formatFrontmatterScalar('Fix #12', TEXT)).toBe('Fix #12');
    expect(formatFrontmatterScalar('2026-01-01', TEXT)).toBe('2026-01-01');
    expect(formatFrontmatterScalar('[WIP]', TEXT)).toBe('"[WIP]"');
    expect(formatFrontmatterScalar('Fix #12')).toBe('"Fix #12"');
  });
});
