/**
 * Round 74 — the `get_graph_importers` MCP tool.
 *
 * The agent-facing half of the module-relocation query. `get_graph_callers` is
 * symbol-scoped and counts call sites, so an agent asking "is this module safe
 * to delete?" through it gets an answer that is silently missing the type-only
 * importers and the re-export bridges. This locks the contract that makes the
 * new tool worth reaching for instead: it is registered, read-only, and its
 * advertised schema matches what the handler actually accepts.
 */
import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/all-tools.ts';
import { PRIMARY_MCP_TOOLS } from '../tools/primary-tools.ts';

const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_importers');

describe('get_graph_importers is wired', () => {
  test('it is registered under a unique wire name', () => {
    expect(tool).toBeDefined();
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names.filter((n) => n === 'get_graph_importers')).toHaveLength(1);
  });

  test('it is a PRIMARY tool — an agent should reach for it before grep', () => {
    expect(PRIMARY_MCP_TOOLS).toContain('get_graph_importers');
  });

  test('it points at the CLI verb that produces the same answer', () => {
    expect(tool!.cliCommand).toBe('graph importers');
  });
});

describe('its advertised schema matches what it accepts', () => {
  const schema = tool!.inputSchema as {
    properties: Record<string, { enum?: string[] }>;
    required: string[];
    additionalProperties: boolean;
  };

  test('`module` is required — there is no useful default target', () => {
    expect(schema.required).toEqual(['module']);
  });

  test('the mode enum is the full set, so a valid mode is never wire-rejected', () => {
    expect(schema.properties['mode']?.enum).toEqual(['import', 'reexport', 'type-only', 'all']);
  });

  test('it refuses unknown properties rather than ignoring them', () => {
    expect(schema.additionalProperties).toBe(false);
  });

  test('a missing module is an input error, not an empty result', async () => {
    const res = await tool!.handler({ module: '  ' }, {
      inspection: { projectRoot: '/nope' },
    } as never);
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe('invalid-input');
  });

  test('a missing index names the command that builds it', async () => {
    const res = await tool!.handler({ module: 'src/a.ts' }, {
      inspection: { projectRoot: '/definitely/not/a/repo' },
    } as never);
    expect(res.isError).toBe(true);
    expect(res.error?.code).toBe('graph-missing');
    expect(res.error?.details).toMatchObject({ nextCommand: 'shrk graph index' });
  });
});
