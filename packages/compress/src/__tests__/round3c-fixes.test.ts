import { describe, expect, test } from 'bun:test';
import {
  EContentType,
  ECompressionStrategy,
  detectContentType,
  compressCode,
  compressLog,
  compressJson,
} from '../index.ts';

describe('round-3c: fixes-of-fixes', () => {
  const code = [
    'import { doStuff, doMore, compute } from "./x";',
    '',
    'export interface IHandlers {',
    '  resolve(): void, options: {',
    '    retries: number;',
    '    timeout: number;',
    '    jitter: boolean;',
    '  };',
    '  name: string;',
    '}',
    '',
    'export function build(items: number[]): Record<string, number> {',
    '  const out: Record<string, number> = {};',
    '  const extra = doStuff(out);',
    '  const more = doMore(extra);',
    '  return out;',
    '}',
    '',
    'export function tup(): [string, number] {',
    '  const a = "x";',
    '  const b = compute();',
    '  return [a, b];',
    '}',
  ].join('\n');

  test('comma in interface member / generic / tuple is handled precisely (A)', () => {
    const r = compressCode(code);
    expect(r.strategy).toBe(ECompressionStrategy.Code);
    // Interface members after `resolve(): void, options: {` are KEPT.
    expect(r.compressed).toContain('retries: number');
    expect(r.compressed).toContain('jitter: boolean');
    expect(r.compressed).toContain('name: string');
    // Generic + tuple return-typed function bodies are ELIDED.
    expect(r.compressed).toContain('build(items: number[]): Record<string, number>');
    expect(r.compressed).toContain('tup(): [string, number]');
    expect(r.compressed).not.toContain('const extra = doStuff');
    expect(r.compressed).not.toContain('const b = compute');
  });

  test('a count phrase mid-trace does not truncate the stack (B)', () => {
    const log = [
      'java.lang.RuntimeException: top level',
      '\tat com.foo.A.run(A.java:10)',
      '\tat com.foo.B.run(B.java:20)',
      'Caused by: java.lang.IllegalStateException: 2 failed preconditions',
      '\tat com.foo.C.check(C.java:30)',
      '\tat com.foo.D.check(D.java:40)',
      'INFO done one',
      'INFO done two',
      'INFO done three',
      'INFO done four',
      'INFO done five',
      'INFO done six',
    ].join('\n');
    const r = compressLog(log);
    expect(r.compressed).toContain('C.java'); // frames after the count-phrase line survive
    expect(r.compressed).toContain('D.java');
  });

  test('a multi-line frame source block is kept whole (C)', () => {
    const log = [
      'Traceback (most recent call last):',
      '  File "a.py", line 10, in foo',
      '    result = do_thing(',
      '        arg_one, arg_two)',
      '  File "b.py", line 20, in bar',
      '    other()',
      'ValueError: boom',
      'INFO p',
      'INFO q',
      'INFO r',
      'INFO s',
      'INFO t',
    ].join('\n');
    expect(compressLog(log).compressed).toContain('arg_one, arg_two)');
  });

  test('cap keeps the real error AND the closing summary amid summary-shaped noise (D)', () => {
    const log = [
      ...Array.from({ length: 15 }, (_, i) => `module${i}: ${i} passed`),
      'ERROR the one real failure here',
      ...Array.from({ length: 15 }, (_, i) => `module${i + 15}: ${i} passed`),
      'Tests: 1 failed, 299 passed',
    ].join('\n');
    const r = compressLog(log, { maxItems: 4 });
    expect(r.compressed).toContain('ERROR the one real failure');
    expect(r.compressed).toContain('Tests: 1 failed');
  });

  test('a source file with an unterminated fence is not misrouted to markdown (E)', () => {
    const src = [
      'function a() {',
      '  const x = `tpl with stray ``` inside`;',
      '  return x;',
      '}',
      'function b() {',
      '  const y = 1;',
      '  return y;',
      '}',
      'function c() {',
      '  return 3;',
      '}',
      'export { a, b, c };',
    ].join('\n');
    expect(detectContentType(src)).not.toBe(EContentType.Markdown);
  });

  test('a less-than after `)` does not mis-elide a following object literal (4th-cycle A)', () => {
    const code = [
      'import { cmp, run } from "./x";',
      '',
      'export const config = [cmp(a) < b, {',
      '  alpha: 1,',
      '  beta: 2,',
      '  gamma: 3,',
      '  delta: 4,',
      '}];',
      '',
      'export function worker(): Map<string, number> {',
      '  const acc = new Map<string, number>();',
      '  for (const item of run()) acc.set(item.id, item.score);',
      '  const total = acc.size;',
      '  const ratio = total / 2;',
      '  return acc;',
      '}',
    ].join('\n');
    const r = compressCode(code);
    expect(r.strategy).toBe(ECompressionStrategy.Code);
    // The object literal's members survive (the `<` is less-than, not a generic).
    expect(r.compressed).toContain('alpha: 1');
    expect(r.compressed).toContain('delta: 4');
    // The function body is still elided.
    expect(r.compressed).not.toContain('const total = acc.size');
  });

  test('exponent underflow to zero forces a precision-preserving passthrough (4th-cycle B)', () => {
    const text =
      '[{"m":1e-400,"label":"row one padded out to make minify win here okay"},' +
      '{"m":2.5,"label":"row two padded out to make minify win here okay too"}]';
    const r = compressJson(text);
    expect(r.strategy).toBe(ECompressionStrategy.Passthrough);
    expect(r.compressed).toBe(text); // 1e-400 not silently flattened to 0
  });

  test('markdown with a stray indented backtick example still detects as markdown (4th-cycle C)', () => {
    const md = [
      '# Title',
      '',
      'Intro prose paragraph at length to anchor the first section here.',
      '',
      '## Section',
      '',
      'An indented literal example line (not a real fence):',
      '',
      '    ``` this is shown as text, indented four spaces',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      'Closing prose for the document tail goes here at length.',
    ].join('\n');
    expect(detectContentType(md)).toBe(EContentType.Markdown);
  });

  test('precision-losing numbers (decimal-split float, exponent overflow) passthrough (F)', () => {
    const decimal =
      '[{"id":1,"lat":90071992547409.93,"label":"row padded out to compress here ok"},' +
      '{"id":2,"lat":1.5,"label":"second row padded out to compress here ok"}]';
    expect(compressJson(decimal).strategy).toBe(ECompressionStrategy.Passthrough);

    const overflow =
      '[{"k":"a","v":1e309,"label":"row padded out to compress here okay"},' +
      '{"k":"b","v":3.5,"label":"row two padded out to compress here okay"}]';
    expect(compressJson(overflow).strategy).toBe(ECompressionStrategy.Passthrough);

    // Ordinary numbers still compact.
    const ok = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, kind: 'x', title: `title ${i}` })),
    );
    expect(compressJson(ok).strategy).toBe(ECompressionStrategy.Table);
  });
});
