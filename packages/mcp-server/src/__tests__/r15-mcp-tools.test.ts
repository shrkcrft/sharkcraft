import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted; audit view is by-construction.

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r15 MCP tools', () => {
  test('runtime tools have name + description (audit projection contract)', () => {
    for (const t of ALL_TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });

  test('every r15 tool is registered', () => {
    const required = [
      'get_bundle_diff',
      'get_ci_permissions_audit',
      'get_release_readiness',
      // get_demo_package_preview removed.
      'get_adoption_checkpoint_status',
      'get_pack_compat_report',
    ];
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const r of required) expect(names.has(r)).toBe(true);
  });

  test('get_bundle_diff returns a structured error when bundles are missing', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_bundle_diff')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = (await tool.handler(
      { a: 'nope-1', b: 'nope-2', format: 'json' },
      { inspection, cwd: DOGFOOD_CWD } as never,
    )) as { isError?: boolean; error?: { code: string } };
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe('not-found');
  });

  test('get_release_readiness returns a checklist', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_release_readiness')!;
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const res = await tool.handler({}, { inspection, cwd: DOGFOOD_CWD } as never);
    const data = res.data as { checklist?: string[]; schema?: string };
    expect(data.schema).toBe('sharkcraft.release-readiness/v1');
    expect((data.checklist ?? []).length).toBeGreaterThan(0);
  });

  // get_demo_package_preview removed.
});
