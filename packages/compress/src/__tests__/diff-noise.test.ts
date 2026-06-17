import { describe, expect, test } from 'bun:test';
import {
  compressDiff,
  InMemoryCcrStore,
  parseCcrMarkers,
  ECompressionStrategy,
} from '../index.ts';

/** A unified-diff section for one file. */
function section(path: string, hunkBody: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${hunkBody.length} +1,${hunkBody.length} @@`,
    ...hunkBody,
  ].join('\n');
}

/** A big, realistic lockfile churn hunk (integrity-hash swaps). */
function lockfileChurn(n: number): string[] {
  const body: string[] = [];
  for (let i = 0; i < n; i += 1) {
    body.push(`-    "integrity": "sha512-OLD${i}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==",`);
    body.push(`+    "integrity": "sha512-NEW${i}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb==",`);
  }
  return body;
}

describe('diff-noise offload (P2.1)', () => {
  test('elides a lockfile section to one marker and recovers it via CCR', () => {
    const store = new InMemoryCcrStore();
    const codeChange = [
      ' export function handler() {',
      '-  return 1;',
      '+  return 2;',
      ' }',
    ];
    const diff = `${section('package-lock.json', lockfileChurn(1000))}\n${section(
      'src/app.ts',
      codeChange,
    )}`;

    const r = compressDiff(diff, { store });
    expect(r.strategy).toBe(ECompressionStrategy.Diff);
    expect(r.lossy).toBe(true);

    // The lockfile collapses to a single marker; its 2000 churn lines are gone.
    expect(r.compressed).toContain('[lockfile package-lock.json:');
    expect(r.compressed).not.toContain('sha512-OLD500');
    // The header stays so the diff is still attributable.
    expect(r.compressed).toContain('diff --git a/package-lock.json b/package-lock.json');
    // The real code change survives untouched.
    expect(r.compressed).toContain('+  return 2;');

    // Big mixed lockfile+code diff: a large reduction.
    expect(r.savings.ratio).toBeGreaterThanOrEqual(0.6);

    // CCR round-trip: the marker key recovers the exact original lockfile section.
    const markers = parseCcrMarkers(r.compressed);
    expect(markers.length).toBeGreaterThan(0);
    const recovered = markers
      .map((m) => store.get(m.key)?.content ?? '')
      .find((c) => c.includes('sha512-OLD500'));
    expect(recovered).toBeDefined();
    expect(recovered).toBe(section('package-lock.json', lockfileChurn(1000)));
  });

  test('elides a whitespace-only hunk and recovers it via CCR', () => {
    const store = new InMemoryCcrStore();
    // 24 lines, every change pure reindentation (tabs/space count only).
    const body: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      body.push(`-  const value${i} = ${i};`);
      body.push(`+      const value${i} = ${i};`);
    }
    const diff = section('src/format.ts', body);

    const r = compressDiff(diff, { store });
    expect(r.lossy).toBe(true);
    expect(r.compressed).toContain('[whitespace-only:');
    // The reindented churn is gone from the wire.
    expect(r.compressed).not.toContain('const value12 = 12;');

    const markers = parseCcrMarkers(r.compressed);
    const recovered = markers.map((m) => store.get(m.key)?.content ?? '').find((c) => c.includes('value12'));
    expect(recovered).toBeDefined();
  });

  test('a normal whitespace-respecting change is NOT treated as whitespace-only', () => {
    const store = new InMemoryCcrStore();
    // Same indentation, different content — a real edit, must survive.
    const body: string[] = [' a', ' b', '-  oldValue();', '+  newValue();', ' c', ' d'];
    for (let i = 0; i < 12; i += 1) body.push(` filler ${i}`);
    const diff = section('src/real.ts', body);

    const r = compressDiff(diff, { store });
    expect(r.compressed).not.toContain('[whitespace-only:');
    expect(r.compressed).not.toContain('[lockfile');
    expect(r.compressed).toContain('+  newValue();');
  });

  test('a code-only diff routes to the core compressor unchanged in spirit', () => {
    const lines = ['diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts'];
    for (let h = 0; h < 20; h += 1) {
      lines.push(`@@ -${h * 10},6 +${h * 10},6 @@`);
      lines.push(` ctx a ${h}`);
      lines.push(`-old line ${h}`);
      lines.push(`+new line ${h}`);
      lines.push(` ctx b ${h}`);
    }
    const r = compressDiff(lines.join('\n'), { maxItems: 4 });
    expect(r.strategy).toBe(ECompressionStrategy.Diff);
    expect(r.compressed).not.toContain('[lockfile');
    expect(r.compressed).not.toContain('[whitespace-only:');
    expect(r.compressed).toContain('+new line 0');
  });

  test('a tiny lockfile diff passes through (net-loss guard)', () => {
    const store = new InMemoryCcrStore();
    const diff = ['diff --git a/yarn.lock b/yarn.lock', '--- a/yarn.lock', '+++ b/yarn.lock', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');
    const r = compressDiff(diff, { store });
    // The marker + CCR overhead exceeds the two trivial lines — ship the original.
    expect(r.strategy).toBe(ECompressionStrategy.Passthrough);
    expect(r.compressed).toBe(diff);
  });
});
