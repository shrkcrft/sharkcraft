import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  EContentType,
  ECompressionStrategy,
  detectContentType,
  compressLog,
  compressDiff,
  compressCode,
  compressMarkdown,
  compressSearch,
  compressJson,
  detectVolatileTokens,
  compactObjectArray,
  renderTable,
  formatCcrMarker,
  parseCcrMarkers,
  FileCcrStore,
  expandColumnar,
} from '../index.ts';

describe('content detection fixes', () => {
  test('code with log-level identifiers is source-code, not build-log (bug 1)', () => {
    expect(detectContentType('function handle() {\n  const ERROR = 500;\n  return ERROR;\n}')).toBe(
      EContentType.SourceCode,
    );
    expect(
      detectContentType('export enum ELevel { INFO, DEBUG, WARN, ERROR, FATAL }\nexport const x = 1;'),
    ).toBe(EContentType.SourceCode);
  });

  test('real logs (level at line start) still detect as build-log', () => {
    expect(detectContentType('INFO start\nINFO work\nERROR boom\nWARN x\nINFO done')).toBe(
      EContentType.BuildLog,
    );
  });

  test('a leading malformed hunk does not defeat diff detection (bug 2)', () => {
    expect(detectContentType('--- old\n+++ new\n@@ malformed @@\n@@ -1,1 +1,1 @@\n-a\n+b')).toBe(
      EContentType.GitDiff,
    );
  });
});

describe('log compressor fixes', () => {
  const trace = [
    'INFO boot',
    ...Array.from({ length: 8 }, (_, i) => `INFO step ${i} routine`),
    'Traceback (most recent call last):',
    '  File "a.py", line 10, in foo',
    '    do_thing()',
    '  File "b.py", line 20, in bar',
    '    other()',
    'ValueError: boom happened',
    'INFO shutdown',
  ].join('\n');

  test('keeps every stack frame + the exception punchline (bug 6)', () => {
    const r = compressLog(trace);
    expect(r.compressed).toContain('File "a.py"');
    expect(r.compressed).toContain('File "b.py"'); // second frame survived
    expect(r.compressed).toContain('ValueError: boom happened');
  });

  test('maxItems cap keeps the closing summary, not just early lines (bug 7)', () => {
    const log = [
      ...Array.from({ length: 30 }, (_, i) => `INFO noise line ${i}`),
      'ERROR something broke',
      'Tests: 1 failed, 5 passed',
    ].join('\n');
    const r = compressLog(log, { maxItems: 5 });
    expect(r.compressed).toContain('Tests: 1 failed');
    expect(r.compressed).toContain('ERROR something broke');
  });

  test('CRLF input with no elision passes through unchanged (bug 8)', () => {
    const text = Array.from({ length: 14 }, (_, i) => `ERROR line ${i}`).join('\r\n');
    const r = compressLog(text);
    expect(r.strategy).toBe(ECompressionStrategy.Passthrough);
    expect(r.compressed).toBe(text); // CRLF preserved, not silently cached
    expect(r.lossy).toBe(false);
  });

  test('keeps keyword-less root-cause lines (segfault / OOM / linker / signal)', () => {
    // None of these carry ERROR/FATAL/FAIL/WARN, and they sit mid-log (not at
    // an anchor), so without the fatal-signal classifier they would be elided.
    const fatal = [
      'INFO starting build pipeline',
      ...Array.from({ length: 6 }, (_, i) => `INFO compiling module ${i} ok`),
      'Segmentation fault (core dumped)',
      'Out of memory: Killed process 4242 (node)',
      "ld: undefined reference to `do_thing'",
      'Assertion failed: ptr != NULL',
      'Process terminated with signal 11',
      ...Array.from({ length: 4 }, (_, i) => `INFO cleanup task ${i} done`),
    ].join('\n');
    const r = compressLog(fatal);
    expect(r.strategy).toBe(ECompressionStrategy.Log); // actually compressed
    expect(r.compressed).toContain('Segmentation fault (core dumped)');
    expect(r.compressed).toContain('Out of memory: Killed process');
    expect(r.compressed).toContain('undefined reference to');
    expect(r.compressed).toContain('Assertion failed');
    expect(r.compressed).toContain('signal 11');
  });
});

describe('search + diff fixes', () => {
  test('Windows drive-letter paths parse and compress (bug 9)', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 20; i += 1) lines.push(`C:\\src\\file.ts:${i}:const v = ${i};`);
    const r = compressSearch(lines.join('\n'), { maxItems: 3 });
    expect(r.strategy).toBe(ECompressionStrategy.Search);
    expect(r.savings.saved).toBeGreaterThan(0);
    expect(r.compressed).toContain('C:\\src\\file.ts:1:');
  });

  test('headerless multi-file diff keeps every file header (bugs 10/11)', () => {
    const hd = [
      '--- a/f1.ts',
      '+++ b/f1.ts',
      '@@ -1,3 +1,3 @@',
      ' ctx top',
      '-old one',
      '+new one',
      ' ctx bot',
      '--- a/f2.ts',
      '+++ b/f2.ts',
      '@@ -1,3 +1,3 @@',
      ' c top',
      '-old two',
      '+new two',
      ' c bot',
    ].join('\n');
    expect(detectContentType(hd)).toBe(EContentType.GitDiff);
    const r = compressDiff(hd, { maxItems: 4 });
    expect(r.compressed).toContain('+++ b/f2.ts'); // second file header not dropped
    expect(r.compressed).toContain('+new two');
  });
});

describe('code outline fixes', () => {
  const cls = [
    'import { compute } from "./x";',
    '',
    'export class Widget {',
    '  private value = 0;',
    '  readonly name = "w";',
    '  render(): string {',
    '    const a = compute();',
    '    const b = a + 1;',
    '    return String(b);',
    '  }',
    '  helper(): number {',
    '    const cfg = { deep: 1, nested: 2 };',
    '    const more = cfg.deep + 10;',
    '    return more;',
    '  }',
    '}',
  ].join('\n');

  test('keeps every method signature on a multi-brace class + fields (bug 13)', () => {
    const r = compressCode(cls);
    expect(r.strategy).toBe(ECompressionStrategy.Code);
    expect(r.compressed).toContain('export class Widget');
    expect(r.compressed).toContain('private value = 0');
    expect(r.compressed).toContain('readonly name');
    expect(r.compressed).toContain('render(): string');
    expect(r.compressed).toContain('helper(): number'); // not dropped despite inline-method class
  });

  test('elides in-body object literals and statements (bug 14)', () => {
    const r = compressCode(cls);
    expect(r.compressed).not.toContain('deep: 1, nested: 2');
    expect(r.compressed).not.toContain('const a = compute');
    expect(r.compressed).not.toContain('const more');
  });
});

describe('volatile-token false-positive fixes', () => {
  test('phone numbers / arbitrary 10-digit IDs are not epochs (bug 15)', () => {
    expect(detectVolatileTokens('call 5551234567 now id 9999999999')).toEqual([]);
  });

  test('ordinary dotted identifiers are not JWTs (bug 16)', () => {
    expect(detectVolatileTokens('see config.settings.default and lodash.debounce.cancel')).toEqual(
      [],
    );
  });
});

describe('json + ccr + render fixes', () => {
  test('large integers force a precision-preserving passthrough (bug 17)', () => {
    const text =
      '[{"id":12345678901234567890,"label":"row zero padded out to compress nicely here"},' +
      '{"id":2,"label":"row two padded out to compress nicely here as well"}]';
    const r = compressJson(text);
    expect(r.strategy).toBe(ECompressionStrategy.Passthrough);
    expect(r.compressed).toBe(text);
    expect(r.lossy).toBe(false);
  });

  test('numeric-looking STRING values do NOT trip the precision guard', () => {
    // Strings round-trip verbatim, so an id/SHA/card that looks numeric must
    // not force passthrough — a list of records with id-like string fields
    // still compacts losslessly. (Enough rows that columnar clearly wins, so
    // Table proves the precision guard didn't fire.)
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `1234567890123456789${i}`,
      sha: `${i}`.repeat(40).slice(0, 40),
      label: `record ${i} padded out so columnar comfortably wins`,
    }));
    const text = JSON.stringify(rows);
    const r = compressJson(text);
    expect(r.strategy).toBe(ECompressionStrategy.Table);
    expect(r.lossy).toBe(false);
    // Exact round trip through the columnar encoding.
    expect(expandColumnar(JSON.parse(r.compressed))).toEqual(rows);
  });

  test('numeric object KEYS do NOT trip the precision guard', () => {
    // Keys are strings in JSON; a long-digit key is not a risky number.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      '12345678901234567890': i,
      label: `record ${i} padded out so columnar comfortably wins here`,
    }));
    const text = JSON.stringify(rows);
    const r = compressJson(text);
    expect(r.strategy).toBe(ECompressionStrategy.Table);
    expect(r.lossy).toBe(false);
    expect(expandColumnar(JSON.parse(r.compressed))).toEqual(rows);
  });

  test('a risky NUMBER alongside numeric-looking strings still forces passthrough', () => {
    // The guard must still catch a genuine precision-losing number value even
    // when numeric-looking strings are present.
    const text =
      '[{"ref":"12345678901234567890","n":12345678901234567890,"label":"row padded out to compress nicely here"},' +
      '{"ref":"22345678901234567890","n":2,"label":"row two padded out to compress nicely here"}]';
    const r = compressJson(text);
    expect(r.strategy).toBe(ECompressionStrategy.Passthrough);
    expect(r.compressed).toBe(text);
    expect(r.lossy).toBe(false);
  });

  test('FileCcrStore rejects path-traversal keys (bug 4)', () => {
    const dir = join(tmpdir(), `shrk-ccr-trav-${process.pid}`);
    try {
      const store = new FileCcrStore(dir);
      expect(store.get('../../../../etc/hosts')).toBeUndefined();
      expect(store.has('../../secrets')).toBe(false);
      // A legitimate round trip still works.
      const key = store.put('hello');
      expect(store.get(key)!.content).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CCR marker note round-trips even with embedded ">>" (bug 5)', () => {
    const m = formatCcrMarker('abcdef0123456789', 'see >> over there');
    const refs = parseCcrMarkers(`x ${m} y`);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.key).toBe('abcdef0123456789');
    expect(refs[0]!.note).toBe('see  over there'); // sanitized, not truncated
  });

  test('renderTable escapes comma / nullable marker in column names (bug 3)', () => {
    const table = compactObjectArray([
      { 'a,b': 1, c: 2 },
      { 'a,b': 3, c: 4 },
    ])!;
    const schemaLine = renderTable(table).split('\n')[1]!;
    // The comma inside the key is escaped, so the schema is unambiguously two
    // columns (`a\,b` and `c`) rather than three.
    expect(schemaLine).toBe('a\\,b,c');
  });
});

describe('round-3 review fixes', () => {
  test('multi-arg generic/tuple return type still elides the body (A)', () => {
    const code = [
      'import { compute } from "./x";',
      '',
      'export function buildIndex(items: number[]): Record<string, number> {',
      '  const out: Record<string, number> = {};',
      '  for (const i of items) out[i] = i;',
      '  const extra = compute(out);',
      '  return out;',
      '}',
      '',
      'export function pair(): [string, number] {',
      '  const a = "x";',
      '  const b = 1;',
      '  return [a, b];',
      '}',
      '',
      'export const z = 1;',
    ].join('\n');
    const r = compressCode(code);
    expect(r.strategy).toBe(ECompressionStrategy.Code);
    expect(r.compressed).toContain('buildIndex(items: number[]): Record<string, number>');
    expect(r.compressed).toContain('pair(): [string, number]');
    expect(r.compressed).not.toContain('const extra = compute');
  });

  test('an indented non-trace dump after an error is elided, not kept whole (B)', () => {
    const log = [
      ...Array.from({ length: 8 }, (_, i) => `INFO step ${i}`),
      'ERROR handler failed',
      '  ----- Captured stdout -----',
      ...Array.from({ length: 30 }, (_, i) => `    payload row ${i} value`),
      'INFO complete',
    ].join('\n');
    const r = compressLog(log);
    expect(r.strategy).toBe(ECompressionStrategy.Log);
    expect(r.savings.saved).toBeGreaterThan(0);
    expect(r.compressed).not.toContain('payload row 15');
    expect(r.compressed).toContain('ERROR handler failed');
  });

  test('summary survives the cap even when errors alone fill it (C)', () => {
    const log = [
      ...Array.from({ length: 20 }, (_, i) => `ERROR failure number ${i}`),
      'Tests: 1 failed, 5 passed',
    ].join('\n');
    expect(compressLog(log, { maxItems: 5 }).compressed).toContain('Tests: 1 failed');
  });

  test('an in-hunk --- / +++ content pair is not mistaken for a new file (D/E)', () => {
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,8 +1,8 @@',
      ' ctx one',
      ' ctx two',
      ' ctx three',
      '-old normal line',
      '+new normal line',
      ' tail ctx',
      '--- deleted dashes content',
      '+++ added plus content',
      ' more ctx after the pair',
      '-x',
      '+y',
    ].join('\n');
    const r = compressDiff(diff);
    // Both real changes survive and nothing was split into a phantom file.
    expect(r.compressed).toContain('+new normal line');
    expect(r.compressed).toContain('+y');
  });

  test('a commented script is not routed to markdown; a prose doc is (F)', () => {
    const script = [
      '#!/usr/bin/env bash',
      '# build helper header',
      '# second comment header',
      'export PATH=/usr/bin',
      'function build() {',
      '  echo building',
      '  return 0',
      '}',
      'build',
    ].join('\n');
    expect(detectContentType(script)).not.toBe(EContentType.Markdown);
    const doc = [
      '# Real Document',
      '',
      'A paragraph of prose introducing the topic at hand here.',
      '',
      '## A Section',
      '',
      'Another paragraph of plain prose with no code at all in it.',
    ].join('\n');
    expect(detectContentType(doc)).toBe(EContentType.Markdown);
  });

  test('syslog progname[pid]: prefixed logs are detected (G)', () => {
    const log = [
      'myapp[12345]: ERROR connection refused',
      'myapp[12345]: WARN retrying in 5s',
      'myapp[12345]: INFO reconnected',
      'myapp[12345]: INFO steady state',
      'myapp[12345]: INFO done',
    ].join('\n');
    expect(detectContentType(log)).toBe(EContentType.BuildLog);
  });

  test('setext headers (=== / ---) survive the markdown outline (H)', () => {
    const md = [
      'Document Title',
      '==============',
      '',
      'Intro lead paragraph at some length to anchor the section.',
      'Continuation prose that is thinned away from the outline here.',
      'More continuation prose padding the section out further still.',
      'Even more continuation prose to make the reduction unambiguous.',
      '',
      'Section Two',
      '-----------',
      '',
      'Section two lead sentence kept as the opener of this section.',
      'Detail one that is dropped from the outline output here.',
      'Detail two that is dropped from the outline output as well.',
    ].join('\n');
    const r = compressMarkdown(md);
    expect(r.strategy).toBe(ECompressionStrategy.Markdown);
    expect(r.compressed).toContain('Document Title');
    expect(r.compressed).toContain('==============');
    expect(r.compressed).toContain('Section Two');
    expect(r.compressed).toContain('-----------');
  });

  test('high-precision floats force a precision-preserving passthrough (I)', () => {
    const text =
      '[{"v":0.12345678901234567890,"label":"row one padded out to compress nicely"},' +
      '{"v":2.5,"label":"row two padded out to compress nicely here as well too"}]';
    const r = compressJson(text);
    expect(r.strategy).toBe(ECompressionStrategy.Passthrough);
    expect(r.compressed).toBe(text);
  });
});
