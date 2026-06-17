import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  EContentType,
  ECompressionStrategy,
  detectContentType,
  estimateTokens,
  measureSavings,
  ccrKey,
  formatCcrMarker,
  parseCcrMarkers,
  InMemoryCcrStore,
  FileCcrStore,
  compactObjectArray,
  tableToColumnar,
  compactArrayToColumnar,
  expandColumnar,
  isColumnarTable,
  renderTable,
  renderCompactJson,
  compressJson,
  compressLog,
  compressSearch,
  compressDiff,
  compressMarkdown,
  compressContent,
} from '../index.ts';

describe('content detection', () => {
  test('classifies the major content types', () => {
    expect(detectContentType('[{"a":1}]')).toBe(EContentType.JsonArray);
    expect(detectContentType('{"a":1}')).toBe(EContentType.Json);
    expect(detectContentType('not [ json { really')).toBe(EContentType.PlainText);
    expect(
      detectContentType('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b'),
    ).toBe(EContentType.GitDiff);
    expect(
      detectContentType('src/a.ts:10:hello\nsrc/a.ts:20:world\nsrc/b.ts:1:foo'),
    ).toBe(EContentType.SearchResults);
    expect(
      detectContentType('INFO starting\nERROR boom\nWARN careful\nFATAL dead\nERROR again'),
    ).toBe(EContentType.BuildLog);
    expect(detectContentType('# Title\n\n- bullet\n- bullet two\n\nsome prose here')).toBe(
      EContentType.Markdown,
    );
  });

  test('empty input is plain text', () => {
    expect(detectContentType('   \n  ')).toBe(EContentType.PlainText);
  });

  test('does not misroute prose/markdown/config that merely ends in punctuation', () => {
    // Markdown bullets ending in ';' stay markdown (code is checked first, must not steal them).
    expect(
      detectContentType('## Setup\n- water the plants;\n- feed the cat;\n- lock the door;'),
    ).toBe(EContentType.Markdown);
    // Prose with trailing semicolons is plain text, not code.
    expect(
      detectContentType('He went to the market;\nShe stayed home;\nThey met for dinner;'),
    ).toBe(EContentType.PlainText);
    // Config (ini / nginx) is not source code. (Real ini has no trailing `;` —
    // `key = value;` IS assignment-statement shape and is intentionally code.)
    expect(
      detectContentType('display_errors = On\nerror_reporting = E_ALL\nmemory_limit = 128M'),
    ).toBe(EContentType.PlainText);
    expect(
      detectContentType('server {\n  listen 80;\n  root /var/www;\n}\nlocation / {\n  index a;\n}'),
    ).toBe(EContentType.PlainText);
  });
});

describe('token accounting', () => {
  test('estimateTokens is monotonic and zero for empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBeGreaterThan(0);
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(estimateTokens('a'.repeat(40)));
  });

  test('measureSavings never reports a net loss', () => {
    const s = measureSavings('aaaaaaaa', 'aaaaaaaaaaaaaaaa'); // output bigger
    expect(s.saved).toBe(0);
    expect(s.ratio).toBe(0);
    const t = measureSavings('a'.repeat(400), 'a'.repeat(40));
    expect(t.saved).toBeGreaterThan(0);
    expect(t.ratio).toBeGreaterThan(0);
  });
});

describe('table compaction (lossless)', () => {
  const items = [
    { id: 'n1', kind: 'rule', title: 'Alpha', summary: 'first' },
    { id: 'n2', kind: 'path', title: 'Beta' }, // summary absent
    { id: 'n3', kind: 'rule', title: 'Gamma', summary: null }, // summary present-null
    { id: 'n4', kind: 'template', title: 'Delta', summary: 'fourth' },
  ];

  test('round-trips through columnar form (absent vs null preserved)', () => {
    const table = compactObjectArray(items);
    expect(table).not.toBeNull();
    const columnar = tableToColumnar(table!);
    expect(isColumnarTable(columnar)).toBe(true);
    const restored = expandColumnar(columnar);
    expect(restored).toEqual(JSON.parse(JSON.stringify(items)));
  });

  test('column order is deterministic (presence desc, then name)', () => {
    const table = compactObjectArray(items)!;
    expect(table.cols.map((c) => c.name)).toEqual(['id', 'kind', 'title', 'summary']);
    expect(table.cols.find((c) => c.name === 'summary')!.nullable).toBe(true);
    expect(table.cols.find((c) => c.name === 'id')!.nullable).toBe(false);
  });

  test('rejects heterogeneous arrays and tiny arrays', () => {
    expect(compactObjectArray([{ a: 1 }])).toBeNull();
    expect(compactObjectArray('nope' as unknown)).toBeNull();
    expect(
      compactObjectArray([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }]),
    ).toBeNull();
  });

  test('renderTable hoists the schema and is smaller than pretty JSON', () => {
    const table = compactObjectArray(items)!;
    const text = renderTable(table);
    expect(text.startsWith('⟦table n=4 c=4⟧')).toBe(true);
    expect(text).toContain('id,kind,title,summary?');
    expect(text.length).toBeLessThan(JSON.stringify(items, null, 2).length);
  });

  test('compactArrayToColumnar is a convenience wrapper', () => {
    expect(compactArrayToColumnar(items)).not.toBeNull();
    expect(compactArrayToColumnar([1, 2, 3])).toBeNull();
  });

  test('compressJson emits valid JSON that round-trips (null/empty/absent distinct)', () => {
    const arr = Array.from({ length: 14 }, (_, i) => {
      const base: Record<string, unknown> = { id: `n${i}`, kind: 'rule', title: `Title number ${i}` };
      if (i === 3) return base; // note absent
      if (i === 4) return { ...base, note: null }; // present-null
      if (i === 5) return { ...base, note: '' }; // empty string
      return { ...base, note: `detail ${i}` };
    });
    const r = compressJson(JSON.stringify(arr));
    expect(r.lossy).toBe(false);
    expect(r.strategy).toBe(ECompressionStrategy.Table);
    const parsedBack: unknown = JSON.parse(r.compressed); // must be valid JSON
    expect(isColumnarTable(parsedBack)).toBe(true);
    expect(expandColumnar(parsedBack as never)).toEqual(JSON.parse(JSON.stringify(arr)));
  });

  test('compressJson preserves a "__proto__" column (no prototype-setter drop)', () => {
    // Built as raw text so the literal "__proto__" survives — JSON.stringify
    // would not re-emit a JSON.parse-created __proto__ own key.
    const parts = Array.from(
      { length: 14 },
      (_, i) => `{"__proto__":${i},"alpha":"a${i}","beta":"b${i}"}`,
    );
    const r = compressJson(`[${parts.join(',')}]`);
    expect(r.strategy).toBe(ECompressionStrategy.Table);
    expect(r.lossy).toBe(false);
    const back = expandColumnar(JSON.parse(r.compressed) as never);
    const d0 = Object.getOwnPropertyDescriptor(back[0], '__proto__');
    expect(d0?.enumerable).toBe(true);
    expect(d0?.value).toBe(0);
    expect(Object.getOwnPropertyDescriptor(back[13], '__proto__')?.value).toBe(13);
    expect((back[13] as Record<string, unknown>).alpha).toBe('a13');
  });

  test('renderCompactJson prefers a table when it is shorter, else minifies', () => {
    const big = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      kind: 'rule',
      title: `Title ${i}`,
    }));
    expect(renderCompactJson(big).startsWith('⟦table')).toBe(true);
    // A scalar / small object minifies (valid JSON).
    expect(renderCompactJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });
});

describe('CCR', () => {
  test('ccrKey is deterministic and 16 hex chars', () => {
    const a = ccrKey('hello world');
    const b = ccrKey('hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(ccrKey('hello world')).not.toBe(ccrKey('hello worle'));
  });

  test('markers round-trip', () => {
    const m = formatCcrMarker('abcdef0123456789', '42 rows offloaded');
    expect(m).toBe('<<ccr:abcdef0123456789 42 rows offloaded>>');
    const refs = parseCcrMarkers(`before ${m} after`);
    expect(refs).toEqual([{ key: 'abcdef0123456789', note: '42 rows offloaded' }]);
    expect(parseCcrMarkers('<<ccr:abcdef0123456789>>')).toEqual([{ key: 'abcdef0123456789' }]);
  });

  test('InMemoryCcrStore stores, retrieves, and evicts oldest at capacity', () => {
    const store = new InMemoryCcrStore(2);
    const k1 = store.put('one');
    const k2 = store.put('two');
    expect(store.size()).toBe(2);
    expect(store.get(k1)!.content).toBe('one');
    const k3 = store.put('three'); // evicts k1
    expect(store.size()).toBe(2);
    expect(store.has(k1)).toBe(false);
    expect(store.get(k2)!.content).toBe('two');
    expect(store.get(k3)!.content).toBe('three');
  });

  test('FileCcrStore persists across instances', () => {
    const dir = join(tmpdir(), `shrk-ccr-test-${process.pid}`);
    try {
      const a = new FileCcrStore(dir);
      const key = a.put('persisted original');
      const b = new FileCcrStore(dir);
      expect(b.has(key)).toBe(true);
      expect(b.get(key)!.content).toBe('persisted original');
      expect(b.size()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lossy compressors', () => {
  test('compressLog keeps errors + summary, reduces, and caches the original', () => {
    const lines: string[] = ['INFO start'];
    for (let i = 0; i < 40; i += 1) lines.push(`INFO step ${i} doing routine work`);
    lines.push('ERROR database connection refused at host db-1');
    for (let i = 0; i < 10; i += 1) lines.push('WARN retrying connection attempt');
    lines.push('Tests: 1 failed, 5 passed');
    const text = lines.join('\n');

    const store = new InMemoryCcrStore();
    const result = compressLog(text, { store });
    expect(result.strategy).toBe(ECompressionStrategy.Log);
    expect(result.savings.saved).toBeGreaterThan(0);
    expect(result.compressed).toContain('ERROR database connection refused');
    expect(result.compressed).toContain('Tests: 1 failed');
    expect(result.compressed).toContain('omitted');
    expect(result.lossy).toBe(true);
    expect(result.ccrKey).toBeDefined();
    expect(store.get(result.ccrKey!)!.content).toBe(text);
  });

  test('compressSearch keeps the first match per file and reduces', () => {
    const lines: string[] = [];
    for (let f = 0; f < 3; f += 1) {
      for (let i = 1; i <= 20; i += 1) lines.push(`src/file${f}.ts:${i}:const value = ${i}`);
    }
    const text = lines.join('\n');
    const result = compressSearch(text, { maxItems: 3 });
    expect(result.strategy).toBe(ECompressionStrategy.Search);
    expect(result.savings.saved).toBeGreaterThan(0);
    expect(result.compressed).toContain('src/file0.ts:1:');
    expect(result.compressed).toContain('src/file2.ts:1:');
  });

  test('compressDiff keeps headers and trims context', () => {
    const lines = ['diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts'];
    for (let h = 0; h < 20; h += 1) {
      lines.push(`@@ -${h * 10},6 +${h * 10},6 @@`);
      lines.push(' context above');
      lines.push(' more context');
      lines.push(`-old line ${h}`);
      lines.push(`+new line ${h}`);
      lines.push(' context below');
      lines.push(' trailing context');
    }
    const text = lines.join('\n');
    const result = compressDiff(text, { maxItems: 4 });
    expect(result.strategy).toBe(ECompressionStrategy.Diff);
    expect(result.savings.saved).toBeGreaterThan(0);
    expect(result.compressed).toContain('diff --git a/big.ts b/big.ts');
    expect(result.compressed).toContain('+new line 0');
  });

  test('compressDiff honours the per-file hunk cap across multiple files', () => {
    const fileDiff = (name: string, hunks: number): string => {
      const lines = [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`];
      for (let h = 0; h < hunks; h += 1) {
        lines.push(`@@ -${h * 10},4 +${h * 10},4 @@`);
        lines.push(' ctx top');
        lines.push(`-old ${name} ${h}`);
        lines.push(`+new ${name} ${h}`);
        lines.push(' ctx bot');
      }
      return lines.join('\n');
    };
    const text = `${fileDiff('a.ts', 5)}\n${fileDiff('b.ts', 5)}`;
    const r = compressDiff(text, { maxItems: 2 });
    expect(r.strategy).toBe(ECompressionStrategy.Diff);
    const countA = (r.compressed.match(/\+new a\.ts /g) ?? []).length;
    const countB = (r.compressed.match(/\+new b\.ts /g) ?? []).length;
    expect(countA).toBeLessThanOrEqual(2);
    expect(countB).toBeLessThanOrEqual(2);
  });

  test('compressJson is lossless and emits a columnar table', () => {
    const arr = Array.from({ length: 30 }, (_, i) => ({
      id: `k${i}`,
      kind: 'knowledge',
      title: `Entry ${i}`,
      source: 'local',
    }));
    const text = JSON.stringify(arr);
    const result = compressJson(text);
    expect(result.lossy).toBe(false);
    expect(result.strategy).toBe(ECompressionStrategy.Table);
    expect(result.savings.saved).toBeGreaterThan(0);
  });
});

describe('compressMarkdown', () => {
  const md = [
    '# Title',
    '',
    'Intro paragraph lead line that introduces the document at some length.',
    'Continuation prose that should be thinned away because it is not the lead.',
    'More continuation prose here that also gets thinned out of the outline.',
    'Yet another continuation sentence padding the first paragraph further.',
    'And a fourth continuation line to make the savings unambiguous here.',
    '',
    '## Section A',
    '',
    'Section A lead sentence that survives as the section opener.',
    'Detail line one of section A that should be dropped from the outline.',
    'Detail line two of section A that should also be dropped from output.',
    'Detail line three of section A padding the section body even more here.',
    'Detail line four of section A to push the reduction well past threshold.',
    '',
    '- item one',
    '- item two',
    '- item three',
    '',
    '```ts',
    'const x = 1;',
    'const y = 2;',
    'const z = 3;',
    'const w = 4;',
    'const u = 5;',
    '```',
    '',
    '## Section B',
    '',
    'Final lead sentence that opens the last section of the document here.',
  ].join('\n');

  test('keeps headers + leads + structure, thins prose & fence bodies, reversible', () => {
    const store = new InMemoryCcrStore();
    const r = compressMarkdown(md, { store });
    expect(r.strategy).toBe(ECompressionStrategy.Markdown);
    expect(r.savings.saved).toBeGreaterThan(0);
    // Structure kept.
    expect(r.compressed).toContain('# Title');
    expect(r.compressed).toContain('## Section A');
    expect(r.compressed).toContain('## Section B');
    expect(r.compressed).toContain('Intro paragraph lead line');
    expect(r.compressed).toContain('Section A lead sentence');
    expect(r.compressed).toContain('```ts'); // fence kept
    // Thinned.
    expect(r.compressed).not.toContain('Continuation prose');
    expect(r.compressed).not.toContain('Detail line two');
    expect(r.compressed).not.toContain('const y = 2'); // fence body elided
    // Reversible.
    expect(store.get(r.ccrKey!)!.content).toBe(md);
  });

  test('compressContent routes detected markdown to compressMarkdown', () => {
    const r = compressContent(md);
    expect(r.contentType).toBe(EContentType.Markdown);
    expect(r.strategy).toBe(ECompressionStrategy.Markdown);
  });
});

describe('router', () => {
  test('compressContent dispatches by detected type', () => {
    expect(compressContent('[{"a":1},{"a":2},{"a":3},{"a":4}]').contentType).toBe(
      EContentType.JsonArray,
    );
    const log = Array.from({ length: 20 }, (_, i) => `INFO line ${i}`).join('\n') + '\nERROR x';
    expect(compressContent(log).contentType).toBe(EContentType.BuildLog);
  });

  test('forced contentType overrides detection', () => {
    const r = compressContent('whatever', { contentType: EContentType.PlainText });
    expect(r.contentType).toBe(EContentType.PlainText);
  });
});
