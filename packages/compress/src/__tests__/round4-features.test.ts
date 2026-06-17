import { describe, expect, test } from 'bun:test';
import {
  EContentType,
  ECompressionStrategy,
  estimateTokens,
  detectContentType,
  compressJson,
  sampleObjectArray,
  isSampledTable,
  expandColumnar,
  alignVolatileTokens,
  restoreVolatileTokens,
  InMemoryCcrStore,
} from '../index.ts';

describe('per-content-type token estimator', () => {
  const blob = 'a'.repeat(800); // char-dominated, no spaces

  test('untyped == PlainText == Markdown (divisor 4, legacy-compatible)', () => {
    const s = 'the quick brown fox jumps over the lazy dog repeatedly here';
    expect(estimateTokens(s)).toBe(estimateTokens(s, EContentType.PlainText));
    expect(estimateTokens(s)).toBe(estimateTokens(s, EContentType.Markdown));
    expect(estimateTokens(s)).toBe(Math.max(Math.ceil(s.length / 4), Math.ceil(s.trim().split(/\s+/).length * 1.3)));
  });

  test('punctuation-dense classes estimate MORE tokens per char (lower ch/tok ratio)', () => {
    // Minified JSON (~2.5 ch/tok) tokenizes to more tokens than prose (~4) for
    // the same characters — a more accurate (higher) count for JSON payloads.
    expect(estimateTokens(blob, EContentType.Json)).toBeGreaterThan(estimateTokens(blob, EContentType.SourceCode));
    expect(estimateTokens(blob, EContentType.SourceCode)).toBeGreaterThan(estimateTokens(blob, EContentType.PlainText));
  });

  test('every content type has a defined ratio (no NaN)', () => {
    for (const t of Object.values(EContentType)) {
      expect(Number.isFinite(estimateTokens(blob, t))).toBe(true);
    }
  });

  test('deterministic', () => {
    expect(estimateTokens(blob, EContentType.Json)).toBe(estimateTokens(blob, EContentType.Json));
  });
});

describe('source-code detection recall', () => {
  test('statement-heavy code (few declarations) now routes to source-code', () => {
    const code = [
      'function handle(input) {',
      '  const parsed = JSON.parse(input);',
      '  result.value = parsed.value;',
      '  arr[index] = parsed.id;',
      '  logger.warn("processed", parsed.id);',
      '  if (parsed.value > 0) {',
      '    queue.push(parsed);',
      '  }',
      '  total = total + parsed.value;',
      '  return total;',
      '}',
    ].join('\n');
    expect(detectContentType(code)).toBe(EContentType.SourceCode);
  });

  test('prose / nginx / realistic ini are NOT misrouted to code', () => {
    expect(
      detectContentType('He went to the market today.\nShe stayed at home.\nThey met for dinner.'),
    ).not.toBe(EContentType.SourceCode);
    expect(
      detectContentType('server {\n  listen 80;\n  root /var/www;\n}\nlocation / {\n  index a;\n}'),
    ).not.toBe(EContentType.SourceCode);
    expect(detectContentType('host = localhost\nport = 5432\nname = app')).not.toBe(
      EContentType.SourceCode,
    );
  });
});

describe('SmartCrusher row sampler', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({
    id: `n${i}`,
    kind: 'item',
    score: i === 250 ? 99999 : i % 10,
    label: `row label number ${i} with descriptive text`,
  }));
  const text = JSON.stringify(rows);

  test('no budget → lossless columnar (unchanged)', () => {
    const r = compressJson(text);
    expect(r.strategy).toBe(ECompressionStrategy.Table);
    expect(r.lossy).toBe(false);
  });

  test('over budget → lossy sample with outliers kept + CCR-recoverable original', () => {
    const store = new InMemoryCcrStore();
    const r = compressJson(text, { maxTokens: 400, store });
    expect(r.strategy).toBe(ECompressionStrategy.Sample);
    expect(r.lossy).toBe(true);
    expect(r.savings.saved).toBeGreaterThan(0);
    const env = JSON.parse(r.compressed.split('\n')[0]!);
    expect(isSampledTable(env)).toBe(true);
    expect(env._table.sample.dropped).toBeGreaterThan(0);
    expect(env._table.sample.kept).toBe(env._table.rows.length);
    expect(env._table.sample.sortField).toBe('score');
    // The numeric outlier survives, srcRows are ascending, original recoverable.
    expect(JSON.stringify(expandColumnar(env)).includes('99999')).toBe(true);
    const src = env._table.sample.srcRows as number[];
    expect(src.every((v, i) => i === 0 || v > src[i - 1]!)).toBe(true);
    expect(store.get(r.ccrKey!)!.content).toBe(text);
  });

  test('sampleObjectArray returns null for non-arrays / non-objects', () => {
    expect(sampleObjectArray('nope')).toBeNull();
    expect(sampleObjectArray([1, 2, 3])).toBeNull();
  });

  test('honours maxItems=1 (never over-keeps the forced endpoints)', () => {
    const s = sampleObjectArray(Array.from({ length: 10 }, (_, i) => ({ a: i })), { maxItems: 1 });
    expect(s!._table.sample.kept).toBe(1);
  });
});

describe('round-4 review fixes', () => {
  test('cache-align round-trips even when input literally contains a placeholder', () => {
    const text = '«vk:uuid:0001» 550e8400-e29b-41d4-a716-446655440000';
    const a = alignVolatileTokens(text);
    expect(restoreVolatileTokens(a.aligned, a.map)).toBe(text); // single pass
  });

  test('a carried map does not corrupt a later turn containing a prior placeholder literal', () => {
    const turn1 = alignVolatileTokens('id 12345678-1234-1234-1234-123456789abc');
    const turn2 = 'the marker «vk:uuid:0001» is literal here';
    const a = alignVolatileTokens(turn2, turn1.map);
    expect(restoreVolatileTokens(a.aligned, a.map)).toBe(turn2);
  });

  test('anchored call signals keep prose/logs out of source-code', () => {
    expect(
      detectContentType('The system.config() handles setup.\nThe cache.invalidate() clears it.\nThe queue.process() runs.'),
    ).not.toBe(EContentType.SourceCode);
    expect(
      detectContentType('Calling fetchUser(42);\nCalling saveOrder(99);\nCalling deleteItem(7);'),
    ).not.toBe(EContentType.SourceCode);
    // ...but real call/statement lines (no prose prefix) still detect as code.
    expect(
      detectContentType('function f(x) {\n  this.handler(x);\n  result.value = x;\n  doThing(x);\n  return x;\n}'),
    ).toBe(EContentType.SourceCode);
  });
});
