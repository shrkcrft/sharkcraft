import { describe, expect, test } from 'bun:test';
import {
  segmentContent,
  compressContent,
  EContentType,
  ECompressionStrategy,
  InMemoryCcrStore,
} from '../index.ts';

const prose = Array.from(
  { length: 16 },
  (_, i) => `This is line ${i} of the incident report describing what happened during the rollout.`,
).join('\n');
const json = JSON.stringify(
  { service: 'payments', replicas: 3, config: { timeout: 30, retries: 5 }, hosts: ['a', 'b', 'c'] },
  null,
  2,
);
const trace = [
  'Traceback (most recent call last):',
  '  File "app.py", line 42, in handler',
  '    process(item)',
  'ValueError: boom happened',
].join('\n');
const mixed = `${prose}\n\n${json}\n\n${trace}`;

describe('mixed-content router (P4.3)', () => {
  test('segments a mixed blob by type', () => {
    const segs = segmentContent(mixed);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    const types = segs.map((s) => s.type);
    expect(types).toContain(EContentType.Json);
    expect(types).toContain(EContentType.BuildLog);
  });

  test('compresses each segment with its own strategy and reassembles', () => {
    const store = new InMemoryCcrStore();
    const r = compressContent(mixed, { store });
    expect(r.strategy).toBe(ECompressionStrategy.Mixed);
    expect(r.savings.saved).toBeGreaterThan(0);
    // JSON block was minified (no pretty whitespace), prose + trace preserved.
    expect(r.compressed).toContain('"service":"payments"');
    expect(r.compressed).toContain('incident report');
    expect(r.compressed).toContain('ValueError: boom happened');
  });

  test('a single-type blob never takes the mixed path', () => {
    // Pure prose → line dedup, not mixed.
    const proseOnly = compressContent(`${prose}\n${prose}`);
    expect(proseOnly.strategy).not.toBe(ECompressionStrategy.Mixed);

    // Pure JSON → table/minified, not mixed.
    const jsonOnly = compressContent(json);
    expect(jsonOnly.strategy).not.toBe(ECompressionStrategy.Mixed);

    // A forced content type never segments.
    const forced = compressContent(mixed, { contentType: EContentType.BuildLog });
    expect(forced.strategy).not.toBe(ECompressionStrategy.Mixed);
  });
});
