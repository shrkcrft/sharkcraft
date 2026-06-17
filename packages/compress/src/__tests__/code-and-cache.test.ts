import { describe, expect, test } from 'bun:test';
import {
  EContentType,
  ECompressionStrategy,
  EVolatileKind,
  compressCode,
  compressContent,
  detectVolatileTokens,
  alignVolatileTokens,
  restoreVolatileTokens,
  InMemoryCcrStore,
} from '../index.ts';

const SAMPLE = `import { foo } from './foo';
import type { IBar } from './bar';

export interface IThing {
  id: string;
  count: number;
}

export function doWork(input: string, opts: IBar = {}): number {
  const parsed = parseInt(input, 10);
  let total = 0;
  if (parsed > 0) {
    total = parsed * 2;
    total = total + 1;
    return total;
  }
  for (let i = 0; i < 10; i += 1) {
    console.log('iteration', i);
    total = total + i;
    total = total * 2;
  }
  const result = total - 1;
  return result;
}

export class Widget {
  private value = 0;
  render(): string {
    const header = '[';
    const middle = this.value.toString();
    const footer = ']';
    const out = header + middle + footer;
    return out;
  }
}
`;

describe('compressCode (outline)', () => {
  test('keeps imports / types / signatures, elides bodies, reversible', () => {
    const store = new InMemoryCcrStore();
    const r = compressCode(SAMPLE, { store });
    expect(r.strategy).toBe(ECompressionStrategy.Code);
    expect(r.lossy).toBe(true);
    expect(r.savings.saved).toBeGreaterThan(0);

    // Kept: structure.
    expect(r.compressed).toContain("import { foo } from './foo'");
    expect(r.compressed).toContain('export interface IThing');
    expect(r.compressed).toContain('id: string');
    expect(r.compressed).toContain('export function doWork');
    expect(r.compressed).toContain('export class Widget');
    expect(r.compressed).toContain('private value = 0');
    expect(r.compressed).toContain('render(): string');

    // Elided: body statements.
    expect(r.compressed).not.toContain('parseInt');
    expect(r.compressed).not.toContain('console.log');
    expect(r.compressed).not.toContain('const out');

    // Reversible.
    expect(r.ccrKey).toBeDefined();
    expect(store.get(r.ccrKey!)!.content).toBe(SAMPLE);
  });

  test('is deterministic', () => {
    expect(compressCode(SAMPLE).compressed).toBe(compressCode(SAMPLE).compressed);
  });

  test('passes small files through untouched', () => {
    const tiny = 'export const x = 1;\nexport const y = 2;';
    const r = compressCode(tiny);
    expect(r.strategy).toBe(ECompressionStrategy.Passthrough);
    expect(r.compressed).toBe(tiny);
  });

  test('compressContent routes detected source code to the outline', () => {
    const r = compressContent(SAMPLE);
    expect(r.contentType).toBe(EContentType.SourceCode);
    expect(r.strategy).toBe(ECompressionStrategy.Code);
  });

  test('regex literals with braces/quotes/backticks do not corrupt the scan', () => {
    // A function whose body holds regexes containing { } " and ` — these used
    // to leak into the brace stack and drop later top-level signatures.
    const REGEXY = [
      "import { x } from './x';",
      '',
      'export function matchOpenBrace(s: string): boolean {',
      '  const re = /\\{[0-9]+/;',
      '  const q = /"/g;',
      '  const bt = /`/g;',
      '  const close = /}/g;',
      '  return re.test(s) || q.test(s) || bt.test(s) || close.test(s);',
      '}',
      '',
      'export function importantPublicApi(input: string): string {',
      '  const result = input.trim();',
      '  return result;',
      '}',
      '',
      'export function anotherPublicApi(): number {',
      '  return 42;',
      '}',
    ].join('\n');
    const r = compressCode(REGEXY);
    expect(r.strategy).toBe(ECompressionStrategy.Code);
    // Top-level signatures AFTER the regex-heavy function survive.
    expect(r.compressed).toContain('export function importantPublicApi');
    expect(r.compressed).toContain('export function anotherPublicApi');
    // Bodies are still elided.
    expect(r.compressed).not.toContain('const result = input.trim()');
  });
});

describe('detectVolatileTokens (cache alignment)', () => {
  test('classifies each volatile kind with counts + a stable order', () => {
    const text =
      'req 550e8400-e29b-41d4-a716-446655440000 and 7c9e6679-7425-40de-944b-e07fc1f90ae7 ' +
      'at 2026-06-15T10:00:00Z hash d41d8cd98f00b204e9800998ecf8427e epoch 1718445600 ' +
      'jwt eyJhbGciOi.eyJzdWIiOj.SflKxwRJSM';
    const found = detectVolatileTokens(text);
    const byKind = new Map(found.map((f) => [f.kind, f]));
    expect(byKind.get(EVolatileKind.Uuid)?.count).toBe(2);
    expect(byKind.get(EVolatileKind.Iso8601)?.count).toBe(1);
    expect(byKind.get(EVolatileKind.HexHash)?.count).toBe(1);
    expect(byKind.get(EVolatileKind.EpochTimestamp)?.count).toBe(1);
    expect(byKind.get(EVolatileKind.Jwt)?.count).toBe(1);
    // Deterministic order regardless of appearance order.
    expect(found.map((f) => f.kind)[0]).toBe(EVolatileKind.Uuid);
    expect(detectVolatileTokens(text)).toEqual(found);
  });

  test('returns nothing for stable prose', () => {
    expect(detectVolatileTokens('the quick brown fox jumps over the lazy dog')).toEqual([]);
  });
});

describe('active cache alignment', () => {
  const text =
    'request 550e8400-e29b-41d4-a716-446655440000 at 2026-06-15T10:00:00Z ' +
    'then again 550e8400-e29b-41d4-a716-446655440000 plus 7c9e6679-7425-40de-944b-e07fc1f90ae7';

  test('aligns volatile tokens to stable placeholders and restores exactly', () => {
    const { aligned, map, replaced } = alignVolatileTokens(text);
    expect(replaced).toBe(4); // 2× first uuid + iso + second uuid
    // Ordinals are PER-KIND, first-appearance order.
    expect(aligned).toContain('«vk:uuid:0001»');
    expect(aligned).toContain('«vk:iso8601:0001»');
    expect(aligned).toContain('«vk:uuid:0002»');
    // Same value ⇒ same placeholder within a map (cache stability).
    expect(aligned.match(/«vk:uuid:0001»/g)!.length).toBe(2);
    // Lossless via restore.
    expect(restoreVolatileTokens(aligned, map)).toBe(text);
  });

  test('is deterministic and never mutates the prior map; carry-forward keeps ordinals', () => {
    const first = alignVolatileTokens(text);
    expect(alignVolatileTokens(text).aligned).toBe(first.aligned);
    const before = JSON.stringify(first.map);
    const next = alignVolatileTokens('new id 11111111-2222-3333-4444-555555555555', first.map);
    expect(JSON.stringify(first.map)).toBe(before); // prior not mutated
    // Previously-seen values keep their ordinals; only the new one is appended.
    expect(next.map.bindings.find((b) => b.original.startsWith('550e8400'))!.ordinal).toBe(1);
    expect(next.map.bindings.some((b) => b.original.startsWith('11111111'))).toBe(true);
  });

  test('preserves quote/comma wrappers around an aligned token and leaves prose alone', () => {
    const { aligned, map } = alignVolatileTokens('"550e8400-e29b-41d4-a716-446655440000",');
    expect(aligned).toBe('"«vk:uuid:0001»",');
    expect(restoreVolatileTokens(aligned, map)).toBe('"550e8400-e29b-41d4-a716-446655440000",');
    expect(alignVolatileTokens('the quick brown fox').replaced).toBe(0);
  });

  test('restoreVolatileTokens ignores corrupt (non-object) bindings instead of throwing', () => {
    const { aligned, map } = alignVolatileTokens(text);
    // A hand-edited / corrupt map file can carry junk in bindings[] that still
    // passes a shallow Array.isArray validation. The documented contract is
    // "never throws"; junk is skipped and real placeholders still restore.
    const corrupt = {
      ...map,
      bindings: [null, 42, undefined, ...map.bindings, { original: 'no-placeholder' }],
    } as unknown as typeof map;
    expect(() => restoreVolatileTokens(aligned, corrupt)).not.toThrow();
    expect(restoreVolatileTokens(aligned, corrupt)).toBe(text);
  });
});
