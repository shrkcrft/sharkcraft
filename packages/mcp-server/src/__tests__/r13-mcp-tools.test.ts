import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted; audit view is by-construction.

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r13 MCP tools', () => {
  test('every runtime tool has a name + description (audit projection contract)', () => {
    // DX#4 — the audit list is derived from ALL_TOOLS at runtime, so
    // parity is by construction. This test now asserts the projection's
    // pre-condition: every tool entry carries the fields the projection reads.
    for (const t of ALL_TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
    }
  });

  test('every r13 tool is registered', () => {
    const required = [
      'create_construct_adoption_plan',
      'get_construct_adoption_review',
      'start_agent_brief_chunks',
      'get_agent_brief_chunk',
      'get_agent_brief_chunk_index',
      'explain_search_tuning',
      'get_pack_release_check',
      'get_ci_scaffold_preview',
      // get_demo_script_preview removed.
    ];
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const r of required) expect(names.has(r)).toBe(true);
  });

  test('chunked-brief tools cache + return chunks', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const start = ALL_TOOLS.find((t) => t.name === 'start_agent_brief_chunks')!;
    const get = ALL_TOOLS.find((t) => t.name === 'get_agent_brief_chunk')!;
    const index = ALL_TOOLS.find((t) => t.name === 'get_agent_brief_chunk_index')!;
    const startRes = (await start.handler({ task: 'r13 test' }, {
      inspection,
      cwd: DOGFOOD_CWD,
    } as never)) as { data?: { briefId: string; totalChunks: number } };
    expect(startRes.data?.briefId).toBeDefined();
    expect(startRes.data!.totalChunks).toBeGreaterThan(0);
    const briefId = startRes.data!.briefId;

    const idxRes = (await index.handler({ briefId }, {
      inspection,
      cwd: DOGFOOD_CWD,
    } as never)) as { data: { totalChunks: number } };
    expect(idxRes.data.totalChunks).toBeGreaterThan(0);

    const firstChunkRes = (await get.handler({ briefId, order: 0 }, {
      inspection,
      cwd: DOGFOOD_CWD,
    } as never)) as { data: { body: string } };
    expect(firstChunkRes.data.body).toContain('SharkCraft brief');

    const missing = (await get.handler({ briefId, order: 999 }, {
      inspection,
      cwd: DOGFOOD_CWD,
    } as never)) as { error?: { code: string } };
    expect(missing.error?.code).toBe('not-found');
  });

  // `get_demo_script_preview` was removed; demo content lives in examples/dogfood-target/.
});
