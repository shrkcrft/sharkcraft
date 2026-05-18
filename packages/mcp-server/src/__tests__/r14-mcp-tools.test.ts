import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted; audit view is by-construction.

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r14 MCP tools', () => {
  test('runtime tools have name + description (audit projection contract)', () => {
    for (const t of ALL_TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });

  test('every r14 tool is registered', () => {
    const required = [
      'get_construct_adoption_diff',
      'get_onboard_adoption_diff',
      'get_pack_doctor_release',
      // get_demo_workflow_preview removed; demo content lives in examples/.
    ];
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const r of required) expect(names.has(r)).toBe(true);
  });

  // get_demo_workflow_preview was removed.

  test('get_ci_scaffold_preview supports gitlab and bitbucket', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_ci_scaffold_preview')!;
    const gitlab = await tool.handler({ provider: 'gitlab', withQuality: true }, {} as never);
    expect((gitlab.data as { body: string }).body).toContain('stages:');
    const bitbucket = await tool.handler({ provider: 'bitbucket', withQuality: true }, {} as never);
    expect((bitbucket.data as { body: string }).body).toContain('pull-requests:');
  });

  test('brief cache miss returns recreate hint', async () => {
    const get = ALL_TOOLS.find((t) => t.name === 'get_agent_brief_chunk')!;
    const res = (await get.handler({ briefId: 'does-not-exist' }, {} as never)) as {
      isError?: boolean;
      error?: { code: string; details?: { canRecreate?: boolean } };
    };
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe('cache-miss');
    expect(res.error?.details?.canRecreate).toBe(true);
  });

  test('construct adoption diff tool round-trips with the dogfood target', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_construct_adoption_diff')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler({ format: 'json' }, { inspection, cwd: DOGFOOD_CWD } as never);
    const data = res.data as { diff: { schema: string }; rendered: string; format: string };
    expect(data.diff.schema).toBe('sharkcraft.construct-adoption-diff/v1');
    expect(data.format).toBe('json');
  });

  test('onboard adoption diff tool returns the expected schema', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_onboard_adoption_diff')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler({ format: 'markdown' }, { inspection, cwd: DOGFOOD_CWD } as never);
    const data = res.data as { diff: { schema: string }; rendered: string; format: string };
    expect(data.diff.schema).toBe('sharkcraft.onboard-adoption-diff/v1');
    expect(data.rendered).toContain('Onboard adoption diff');
  });
});
