import { describe, expect, test } from 'bun:test';
import { bm25Scores, topByBm25, sampleObjectArray, compressSearch, expandColumnar } from '../index.ts';

describe('BM25 relevance (P3.2)', () => {
  test('ranks a uniquely-relevant doc above one repeating a common word', () => {
    const docs = [
      'the the the the the common common common',
      'the quick brown migration rollback procedure',
      'the the the the the the the the the the',
    ];
    const scores = bm25Scores('migration rollback', docs);
    // Only doc 1 contains the rare query terms → it must score highest.
    expect(scores[1]).toBeGreaterThan(scores[0]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
    expect(scores[0]).toBe(0);
  });

  test('boosts exact ID-shaped term matches (UUID)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const docs = [
      'request failed for user account during processing',
      `request failed for session ${uuid} during processing`,
      'request failed for user account during processing',
    ];
    const ranked = topByBm25(`failed ${uuid}`, docs, 3);
    // The doc carrying the exact UUID is the top hit.
    expect(ranked[0]).toBe(1);
  });

  test('empty query → all zeros (no-query fallback)', () => {
    const docs = ['anything here', 'and here too'];
    expect(bm25Scores('', docs)).toEqual([0, 0]);
    expect(topByBm25('', docs, 5)).toEqual([]);
  });

  test('deterministic', () => {
    const docs = Array.from({ length: 30 }, (_, i) => `row ${i} kind ${i % 3} note text`);
    expect(bm25Scores('kind 2', docs)).toEqual(bm25Scores('kind 2', docs));
  });

  test('sampler retains a uniquely-relevant row that overlap would rank low', () => {
    // 60 rows mention "service"; exactly one also mentions the rare query term.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      kind: 'service',
      note: i === 37 ? 'restart kafka consumer rebalance' : 'routine service heartbeat ok',
    }));
    const sampled = sampleObjectArray(rows, { query: 'kafka rebalance', maxItems: 6, matches: 4 })!;
    // Decode (values may be value-dictionary encoded) before checking retention.
    const kept = JSON.stringify(expandColumnar(sampled));
    expect(kept).toContain('r37');
    expect(kept).toContain('kafka');
  });

  test('compressSearch biases retained hits toward the query', () => {
    const lines: string[] = [];
    // One file, many hits; only line 25 is truly relevant to the query.
    for (let i = 1; i <= 40; i += 1) {
      const body = i === 25 ? 'deadlock detected on payments ledger' : `routine debug log entry ${i}`;
      lines.push(`src/app.ts:${i}:${body}`);
    }
    const r = compressSearch(lines.join('\n'), { query: 'deadlock payments', maxItems: 3 });
    expect(r.compressed).toContain('deadlock detected on payments ledger');
  });
});
