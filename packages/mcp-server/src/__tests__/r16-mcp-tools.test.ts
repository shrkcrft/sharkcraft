import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/index.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted; audit view is by-construction.

describe('r16 mcp tools', () => {
  test('runtime tools have name + description (audit projection contract)', () => {
    for (const t of ALL_TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });
  test('tools are registered', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const expected of [
      'get_start_here',
      'get_primary_commands',
      // create_agent_handoff removed; folded into create_agent_brief.
      'get_repository_map',
      'get_docs_check',
      'get_examples_check',
      'get_ci_permissions_fix_preview',
      'get_release_smoke_report',
      // get_demo_package_validation removed.
      'get_self_audit',
      'get_install_smoke_report',
    ]) {
      expect(names).toContain(expected);
    }
  });
  test('every tool returns data shape', async () => {
    const ctx = {
      cwd: process.cwd(),
      inspection: await (await import('@shrkcrft/inspector')).inspectSharkcraft({ cwd: process.cwd() }),
    };
    const targets = [
      'get_start_here',
      'get_primary_commands',
      'get_release_smoke_report',
      'get_install_smoke_report',
    ];
    for (const name of targets) {
      const tool = ALL_TOOLS.find((t) => t.name === name)!;
      const result = await tool.handler({}, ctx as never);
      expect(result.data).toBeDefined();
    }
  });
});
