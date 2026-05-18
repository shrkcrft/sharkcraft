import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/index.ts';
// DX#4 — `ALL_TOOLS_FOR_AUDIT` deleted; audit view is by-construction.

describe('r17 mcp tools', () => {
  test('runtime tools have name + description (audit projection contract)', () => {
    for (const t of ALL_TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });
  test('diagnostic tools are registered', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names).toContain('get_diagnostic_for_code');
    expect(names).toContain('list_diagnostics');
  });
  test('get_diagnostic_for_code returns data for a known code', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_diagnostic_for_code')!;
    const result = await tool.handler({ code: 'mcp-cache-miss', context: { briefId: 'abc' } }, {
      cwd: process.cwd(),
      inspection: undefined as never,
    } as never);
    expect(result.data).toBeDefined();
    expect(((result.data as { problem: string }).problem)).toContain('abc');
  });
  test('get_diagnostic_for_code returns an error for unknown codes', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_diagnostic_for_code')!;
    const result = await tool.handler({ code: 'no-such-code' }, {
      cwd: process.cwd(),
      inspection: undefined as never,
    } as never);
    expect(result.isError).toBe(true);
  });
});
