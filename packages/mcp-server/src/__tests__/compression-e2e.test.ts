import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isColumnarTable } from '@shrkcrft/compress';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SERVER_MAIN = join(REPO_ROOT, 'packages/mcp-server/src/main.ts');

/** Parse the first text content block that is valid JSON (the tool's `data`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dataOf(result: any): any {
  for (const c of result.content ?? []) {
    if (c?.type === 'text') {
      try {
        return JSON.parse(c.text);
      } catch {
        /* the human summary block — skip */
      }
    }
  }
  return null;
}

/**
 * End-to-end over the real stdio wire: the in-memory CCR store + columnar
 * encoding + reversible cache-alignment all work across live tool calls in one
 * server session.
 */
describe('compression tools — live MCP wire', () => {
  test(
    'compress→retrieve, format:table decode, align→restore round-trip',
    async () => {
      const transport = new StdioClientTransport({
        command: 'bun',
        args: ['run', SERVER_MAIN, '--cwd', REPO_ROOT],
      });
      const client = new Client({ name: 'shrk-compress-e2e', version: '0.0.0' });
      try {
        await client.connect(transport);

        // 1. compress_context (lossy log) → ccrKey; retrieve_original recovers it.
        const log =
          Array.from({ length: 40 }, (_, i) => `INFO step ${i} routine work`).join('\n') +
          '\nERROR boom failure occurred';
        const compressed = dataOf(await client.callTool({ name: 'compress_context', arguments: { content: log } }));
        expect(compressed.tokensSaved).toBeGreaterThan(0);
        expect(typeof compressed.ccrKey).toBe('string');

        const recovered = dataOf(
          await client.callTool({ name: 'retrieve_original', arguments: { key: compressed.ccrKey } }),
        );
        expect(recovered.content).toBe(log); // CCR survived across calls in one session

        // 2. get_knowledge_graph format:"table" → valid columnar over the wire.
        const graph = dataOf(await client.callTool({ name: 'get_knowledge_graph', arguments: { format: 'table' } }));
        expect(graph.format).toBe('table');
        expect(isColumnarTable(graph.nodes)).toBe(true);

        // 3. align_cache → restore_cache round-trips exactly.
        const text = 'req 550e8400-e29b-41d4-a716-446655440000 at 2026-06-15T10:00:00Z';
        const aligned = dataOf(await client.callTool({ name: 'align_cache', arguments: { content: text } }));
        expect(aligned.replaced).toBeGreaterThan(0);
        const restored = dataOf(
          await client.callTool({
            name: 'restore_cache',
            arguments: { content: aligned.aligned, map: aligned.map },
          }),
        );
        expect(restored.restored).toBe(text);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    30000,
  );
});
