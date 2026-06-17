import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { inspectSharkcraft, buildKnowledgeGraph } from '@shrkcrft/inspector';
import {
  estimateTokens,
  compactArrayToColumnar,
  compressContent,
  EContentType,
} from '@shrkcrft/compress';
import { serializeToolData } from '../server/serialize-tool-data.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/**
 * Optional real BPE tokenizer (cl100k_base) for dev-only floors. Mirrors
 * `scripts/lib/real-tokens.ts` but inlined so this package test takes no
 * cross-boundary import on repo `scripts/`. Returns null when the dev-only
 * `gpt-tokenizer` dependency is absent (e.g. a published install), in which
 * case the real-token floors are skipped rather than failing spuriously.
 */
async function loadRealTokenizer(): Promise<((s: string) => number) | null> {
  try {
    const mod = (await import('gpt-tokenizer')) as { encode?: (s: string) => number[] };
    if (typeof mod.encode !== 'function') return null;
    const encode = mod.encode;
    return (s: string): number => (s ? encode(s).length : 0);
  } catch {
    return null;
  }
}

/**
 * A representative homogeneous "hit" array of the exact shape the newly-wired
 * columnar tools emit (`search_all`, `code_find_usages`, `search_knowledge`,
 * `command_catalog`, `deps_audit`, `get_knowledge_graph` all route their list
 * through `compactArrayToColumnar`). Flooring the shared mechanism on a fixed
 * payload is deterministic and environment-independent — unlike invoking each
 * handler, which depends on optional on-disk indices.
 */
function representativeHits(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    file: `packages/core/src/module-${i % 7}.ts`,
    line: (i * 3) % 240,
    column: i % 12,
    kind: i % 2 === 0 ? 'reference' : 'definition',
    symbol: `handler${i % 9}`,
    score: Math.round((1 - i / n) * 1000) / 1000,
  }));
}

interface IFloorRow {
  surface: string;
  before: number;
  after: number;
  pct: number;
  floor: number;
}

/**
 * Deterministic savings benchmark + regression FLOOR. Measures the token cost
 * of shrk's high-volume agent-facing surfaces before/after compression on this
 * repo, prints a table, and asserts a conservative per-surface floor. A future
 * change that bloats a payload past where compression still clears its floor
 * fails here. Floors are intentionally well below observed savings to avoid
 * flakiness across environments.
 */
describe('payload savings floor', () => {
  test(
    'compression clears a per-surface savings floor (estimator)',
    async () => {
      const inspection = await inspectSharkcraft({ cwd: REPO_ROOT });
      const graph = buildKnowledgeGraph(inspection);
      const results: IFloorRow[] = [];

      const record = (surface: string, before: number, after: number, floor: number): void => {
        const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
        results.push({ surface, before, after, pct, floor });
      };

      // 1. Knowledge graph — pretty JSON (old default) vs columnar table.
      const graphPayload = { nodes: graph.nodes, edges: graph.edges };
      const graphPretty = estimateTokens(JSON.stringify(graphPayload, null, 2));
      const graphTable = estimateTokens(
        serializeToolData({
          nodes: compactArrayToColumnar(graph.nodes) ?? graph.nodes,
          edges: compactArrayToColumnar(graph.edges) ?? graph.edges,
        }),
      );
      record('knowledge-graph (table vs pretty)', graphPretty, graphTable, 25);

      // 2. Knowledge nodes — minified array vs columnar.
      const nodesMin = estimateTokens(JSON.stringify(graph.nodes));
      const nodesTab = estimateTokens(serializeToolData(compactArrayToColumnar(graph.nodes) ?? graph.nodes));
      record('knowledge nodes (columnar vs minified)', nodesMin, nodesTab, 10);

      // 3. A real markdown doc → markdown outline.
      const md = readFileSync(join(REPO_ROOT, 'docs/compression.md'), 'utf8');
      const mdR = compressContent(md);
      record('docs/compression.md (markdown)', mdR.savings.before, mdR.savings.after, 25);

      // 4. A real source file → code outline.
      const code = readFileSync(
        join(REPO_ROOT, 'packages/compress/src/text/compress-log.ts'),
        'utf8',
      );
      const codeR = compressContent(code, { contentType: undefined });
      record('compress-log.ts (code outline)', codeR.savings.before, codeR.savings.after, 30);

      // 5. Newly-wired columnar tools — representative hit array (shared path).
      const hits = representativeHits(40);
      const hitsMin = estimateTokens(JSON.stringify(hits));
      const hitsTab = estimateTokens(serializeToolData(compactArrayToColumnar(hits) ?? hits));
      record('columnar tool hits (40 rows)', hitsMin, hitsTab, 30);

      // 6. Lossy build log — repetitive worker lines + a real error block.
      const log = [
        ...Array.from(
          { length: 40 },
          (_, i) => `2026-06-16T10:00:${String(i).padStart(2, '0')}Z INFO worker ${i % 4} processing batch ${i} ok`,
        ),
        'ERROR TypeError: cannot read property "id" of undefined',
        '    at handle (/app/src/router.ts:42:11)',
        'Segmentation fault (core dumped)',
        ...Array.from(
          { length: 20 },
          (_, i) => `2026-06-16T10:01:${String(i).padStart(2, '0')}Z INFO retry ${i} scheduled`,
        ),
      ].join('\n');
      const logR = compressContent(log, { contentType: EContentType.BuildLog });
      record('build log (lossy)', logR.savings.before, logR.savings.after, 50);

      // 7. Lossy search results — many low-signal grep hits across a few files.
      const search = Array.from({ length: 60 }, (_, i) => {
        const file = `packages/core/src/file-${i % 4}.ts`;
        return `${file}:${(i * 7) % 300}:  const value${i} = compute(${i});`;
      }).join('\n');
      const searchR = compressContent(search, { contentType: EContentType.SearchResults });
      record('search results (lossy)', searchR.savings.before, searchR.savings.after, 15);

      // 8. Lossy unified diff — several files, wide context around small changes.
      const diff = buildRepresentativeDiff();
      const diffR = compressContent(diff, { contentType: EContentType.GitDiff });
      record('git diff (lossy)', diffR.savings.before, diffR.savings.after, 15);

      // eslint-disable-next-line no-console
      console.table(results);

      for (const r of results) {
        expect(r.pct).toBeGreaterThanOrEqual(r.floor);
      }
    },
    30000,
  );

  // Dev-only real-tokenizer floors. The estimator is sound on percentages but
  // these prove the savings hold under an actual BPE tokenizer (the tokens an
  // agent really pays). Skipped gracefully where `gpt-tokenizer` is absent.
  test(
    'compression clears a real-token savings floor (when a tokenizer is present)',
    async () => {
      const real = await loadRealTokenizer();
      if (!real) {
        // eslint-disable-next-line no-console
        console.log('real-token floors skipped: gpt-tokenizer not installed');
        return;
      }

      const inspection = await inspectSharkcraft({ cwd: REPO_ROOT });
      const graph = buildKnowledgeGraph(inspection);
      const results: IFloorRow[] = [];
      const record = (surface: string, before: number, after: number, floor: number): void => {
        const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
        results.push({ surface, before, after, pct, floor });
      };

      const graphBefore = real(JSON.stringify({ nodes: graph.nodes, edges: graph.edges }));
      const graphAfter = real(
        serializeToolData({
          nodes: compactArrayToColumnar(graph.nodes) ?? graph.nodes,
          edges: compactArrayToColumnar(graph.edges) ?? graph.edges,
        }),
      );
      record('knowledge-graph (real tokens)', graphBefore, graphAfter, 10);

      const md = readFileSync(join(REPO_ROOT, 'docs/compression.md'), 'utf8');
      const mdR = compressContent(md);
      record('markdown (real tokens)', real(md), real(mdR.compressed), 25);

      const log = [
        ...Array.from(
          { length: 40 },
          (_, i) => `2026-06-16T10:00:${String(i).padStart(2, '0')}Z INFO worker ${i % 4} processing batch ${i} ok`,
        ),
        'ERROR boom',
        ...Array.from({ length: 20 }, (_, i) => `2026-06-16T10:01:${String(i).padStart(2, '0')}Z INFO retry ${i}`),
      ].join('\n');
      const logR = compressContent(log, { contentType: EContentType.BuildLog });
      record('build log (real tokens)', real(log), real(logR.compressed), 50);

      // eslint-disable-next-line no-console
      console.table(results);
      for (const r of results) {
        expect(r.pct).toBeGreaterThanOrEqual(r.floor);
      }
    },
    30000,
  );
});

/** A multi-file unified diff with wide context around small edits. */
function buildRepresentativeDiff(): string {
  const fileSection = (name: string, changeAt: number): string => {
    const ctx = (j: number): string => ` const line${j} = ${j};`;
    const lines: string[] = [
      `diff --git a/${name} b/${name}`,
      `index 1111111..2222222 100644`,
      `--- a/${name}`,
      `+++ b/${name}`,
      `@@ -1,24 +1,24 @@`,
    ];
    for (let j = 0; j < 24; j += 1) {
      if (j === changeAt) {
        lines.push(`-${ctx(j)}`);
        lines.push(`+${ctx(j)} // edited`);
      } else {
        lines.push(ctx(j));
      }
    }
    return lines.join('\n');
  };
  return [
    fileSection('packages/core/src/a.ts', 11),
    fileSection('packages/core/src/b.ts', 5),
    fileSection('packages/core/src/c.ts', 18),
  ].join('\n');
}
