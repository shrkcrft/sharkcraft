import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/index.ts';

const R23_TOOLS = [
  'create_agent_contract',
  'simulate_plan',
  'get_memory_report',
  'get_memory_risk',
  'list_memory_files',
  'get_memory_diagnostics',
  'create_healing_plan',
  'create_execution_graph',
] as const;

describe('r23 mcp tools', () => {
  test('all expected MCP tools are registered', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const expected of R23_TOOLS) {
      expect(names).toContain(expected);
    }
  });

  test('tools advertise read-only intent in their descriptions', () => {
    for (const name of R23_TOOLS) {
      const tool = ALL_TOOLS.find((t) => t.name === name)!;
      expect(tool.description.toLowerCase()).toContain('read-only');
    }
  });

  test(
    'create_agent_contract returns a contract for a task',
    async () => {
      const ctx = {
        cwd: process.cwd(),
        inspection: await (await import('@shrkcrft/inspector')).inspectSharkcraft({
          cwd: process.cwd(),
        }),
      };
      const tool = ALL_TOOLS.find((t) => t.name === 'create_agent_contract')!;
      const result = await tool.handler({ task: 'docs cleanup', role: 'developer' }, ctx as never);
      expect(result.isError).not.toBe(true);
      expect(result.data).toBeDefined();
    },
    // inspectSharkcraft() walks the full engine repo and the catalog is
    // big — this can flake past 5s under full-suite parallel contention.
    30_000,
  );

  test(
    'create_execution_graph returns nodes and edges',
    async () => {
      const ctx = {
        cwd: process.cwd(),
        inspection: await (await import('@shrkcrft/inspector')).inspectSharkcraft({
          cwd: process.cwd(),
        }),
      };
      const tool = ALL_TOOLS.find((t) => t.name === 'create_execution_graph')!;
      const result = await tool.handler({ task: 'add a new CLI subcommand', role: 'developer' }, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { nodes: unknown[]; edges: unknown[] };
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(Array.isArray(data.edges)).toBe(true);
    },
    // inspectSharkcraft() walks the full engine repo and the catalog is
    // big — this can take >5s under full-suite parallel contention.
    30_000,
  );

  test('create_healing_plan accepts errorText input', async () => {
    const ctx = {
      cwd: process.cwd(),
      inspection: await (await import('@shrkcrft/inspector')).inspectSharkcraft({
        cwd: process.cwd(),
      }),
    };
    const tool = ALL_TOOLS.find((t) => t.name === 'create_healing_plan')!;
    const result = await tool.handler({ errorText: 'Cannot find module foo' }, ctx as never);
    expect(result.isError).not.toBe(true);
    expect((result.data as { recommendedCommands: string[] }).recommendedCommands.length).toBeGreaterThan(0);
  });

  test('get_memory_risk works without an index (no-memory)', async () => {
    // We expect this to return data even if no index has been built yet.
    const tmp = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = tmp.mkdtempSync(path.join(os.tmpdir(), 'shrk-r23-mcp-mem-'));
    try {
      tmp.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0' }),
      );
      const ctx = {
        cwd: root,
        inspection: await (await import('@shrkcrft/inspector')).inspectSharkcraft({ cwd: root }),
      };
      const tool = ALL_TOOLS.find((t) => t.name === 'get_memory_risk')!;
      const result = await tool.handler({ task: 'anything' }, ctx as never);
      expect(result.isError).not.toBe(true);
      expect((result.data as { recommendation: string }).recommendation).toBe('no-memory');
    } finally {
      tmp.rmSync(root, { recursive: true, force: true });
    }
  });
});
