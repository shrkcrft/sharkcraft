/**
 * Ground-truth validation of the compression layer's savings using a REAL BPE
 * tokenizer (gpt-tokenizer / cl100k_base — the standard proxy; Claude's exact
 * tokenizer is not public, but BPE token counts track closely). Measures real
 * tokens before (the explicit json wire shape) vs after (columnar table /
 * compressed) on the ACTUAL largest payloads this repo produces, and compares
 * the real saving to what the deterministic estimator claimed.
 *
 *   bun run scripts/compress-validate.ts
 *
 * Read-only. No writes, no commits.
 */
import { readFileSync } from 'node:fs';
import {
  compressContent,
  compactArrayToColumnar,
  estimateTokens,
  EContentType,
} from '../packages/compress/src/index.ts';
import { inspectSharkcraft, buildDashboardKnowledgeGraph } from '../packages/inspector/src/index.ts';

const enc = (await import('gpt-tokenizer')) as { encode: (s: string) => number[] };
const real = (s: string): number => enc.encode(s).length;

interface IRow {
  surface: string;
  realBefore: number;
  realAfter: number;
  realPct: number;
  estPct: number;
  estErrBeforePct: number; // |estimator before − real before| / real before
}

const rows: IRow[] = [];

function record(
  surface: string,
  before: string,
  after: string,
  estContentType: EContentType,
): void {
  const rb = real(before);
  const ra = real(after);
  const estBefore = estimateTokens(before, estContentType);
  const estAfter = estimateTokens(after, estContentType);
  rows.push({
    surface,
    realBefore: rb,
    realAfter: ra,
    realPct: rb > 0 ? Math.round((1 - ra / rb) * 100) : 0,
    estPct: estBefore > 0 ? Math.round((1 - estAfter / estBefore) * 100) : 0,
    estErrBeforePct: rb > 0 ? Math.round((Math.abs(estBefore - rb) / rb) * 100) : 0,
  });
}

// 1) The headline MCP payload: the knowledge graph (default json vs table).
const inspection = await inspectSharkcraft({ cwd: process.cwd() });
const g = buildDashboardKnowledgeGraph(inspection);
const nodes = [...g.nodes];
const edges = [...g.edges];
record(
  `knowledge graph (${nodes.length} nodes, ${edges.length} edges)`,
  JSON.stringify({ nodes, edges }),
  JSON.stringify({
    nodes: compactArrayToColumnar(nodes) ?? nodes,
    edges: compactArrayToColumnar(edges) ?? edges,
  }),
  EContentType.Json,
);

// 2) A real markdown doc through the markdown compressor.
const md = readFileSync('docs/compression.md', 'utf8');
record('markdown: docs/compression.md', md, compressContent(md, { contentType: EContentType.Markdown }).compressed, EContentType.Markdown);

// 3) A real source file through the code outliner.
const code = readFileSync('packages/compress/src/text/compress-log.ts', 'utf8');
record('source: compress-log.ts', code, compressContent(code, { contentType: EContentType.SourceCode }).compressed, EContentType.SourceCode);

// 4) A representative build log through the log compressor.
const log = [
  ...Array.from({ length: 40 }, (_, i) => `2026-06-16T10:00:${String(i).padStart(2, '0')}Z INFO worker ${i % 4} processing batch ${i} ok`),
  'ERROR TypeError: cannot read property "id" of undefined',
  '    at handle (/app/src/router.ts:42:11)',
  '    at dispatch (/app/src/server.ts:88:7)',
  'Segmentation fault (core dumped)',
  ...Array.from({ length: 20 }, (_, i) => `2026-06-16T10:01:${String(i).padStart(2, '0')}Z INFO retry ${i} scheduled`),
  'Tests: 1 failed, 63 passed',
].join('\n');
record('build log (synthetic, 64 lines)', log, compressContent(log, { contentType: EContentType.BuildLog }).compressed, EContentType.BuildLog);

// Report.
const f = (n: number): string => String(n).padStart(7);
const p = (n: number): string => `${n}%`.padStart(6);
console.log('\nGround-truth token savings (real BPE tokenizer: gpt-tokenizer / cl100k_base)\n');
console.log('surface                                       real→   realafter  real%   est%   |est−real| on "before"');
console.log('─'.repeat(104));
let tb = 0;
let ta = 0;
for (const r of rows) {
  tb += r.realBefore;
  ta += r.realAfter;
  console.log(
    `${r.surface.padEnd(44)} ${f(r.realBefore)} ${f(r.realAfter)}   ${p(r.realPct)}  ${p(r.estPct)}   ${p(r.estErrBeforePct)}`,
  );
}
console.log('─'.repeat(104));
console.log(`${'TOTAL (real tokens an agent pays)'.padEnd(44)} ${f(tb)} ${f(ta)}   ${p(Math.round((1 - ta / tb) * 100))}`);
console.log(`\nReal aggregate reduction: ${tb} → ${ta} tokens (−${Math.round((1 - ta / tb) * 100)}%).`);
console.log('Note: cl100k_base ≈ Claude tokenization but not identical; treat as a close proxy.\n');
