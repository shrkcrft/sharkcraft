import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/index.ts';
import { PRIMARY_MCP_TOOLS } from '../tools/primary-tools.ts';
import { COLUMNAR_LEGEND } from '../server/columnar-format.ts';

/** Every registered tool name — used to tell a tool reference from prose. */
const ALL_TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));

/** Tools actually advertised in the default `tools/list` surface. */
const PRIMARY_TOOLS = ALL_TOOLS.filter((t) => PRIMARY_MCP_TOOLS.has(t.name));

/**
 * Extract backtick-quoted tokens from the sentence(s) of `description` that
 * recommend another tool via the word "Prefer". Only tokens that are real
 * registered tool names are returned — `shrk surface enable <cmd>` and other
 * non-tool backtick prose are filtered out.
 */
function preferredToolNames(description: string): string[] {
  const out: string[] = [];
  for (const sentence of description.split('.')) {
    if (!sentence.includes('Prefer')) continue;
    for (const match of sentence.matchAll(/`([^`]+)`/g)) {
      const token = match[1]!;
      if (ALL_TOOL_NAMES.has(token)) out.push(token);
    }
  }
  return out;
}

describe('primary-tools honesty (M1)', () => {
  // The four surfaces the descriptions advertise must be registered tools.
  test.each(['prepare_agent_task', 'get_knowledge_graph', 'deps_audit', 'smart_context_bundle'])(
    '%s is a registered tool',
    (name) => {
      expect(ALL_TOOL_NAMES.has(name)).toBe(true);
    },
  );

  // …and must be in the default-advertised PRIMARY surface, not hidden behind
  // SHRK_MCP_FULL_TOOLS, or agents never discover them.
  test('prepare_agent_task is advertised in PRIMARY', () => {
    expect(PRIMARY_MCP_TOOLS.has('prepare_agent_task')).toBe(true);
  });

  test.each(['get_knowledge_graph', 'deps_audit', 'smart_context_bundle'])(
    'compression surface %s is advertised in PRIMARY',
    (name) => {
      expect(PRIMARY_MCP_TOOLS.has(name)).toBe(true);
    },
  );

  // Honesty guard: any tool a PRIMARY description tells the agent to "Prefer"
  // must itself be advertised in PRIMARY — otherwise the recommendation points
  // at a tool the agent can never see in the default surface.
  test('every "Prefer `<tool>`" reference in a PRIMARY description is itself PRIMARY', () => {
    const dangling: Array<{ tool: string; references: string }> = [];
    for (const tool of PRIMARY_TOOLS) {
      for (const referenced of preferredToolNames(tool.description)) {
        if (!PRIMARY_MCP_TOOLS.has(referenced)) {
          dangling.push({ tool: tool.name, references: referenced });
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  // Honesty guard: any tool whose description promises it is the "call this
  // FIRST" entrypoint must be advertised in PRIMARY (this is exactly the M1
  // regression — prepare_agent_task said FIRST but was not advertised).
  test('every "call this FIRST" tool is advertised in PRIMARY', () => {
    const hidden = ALL_TOOLS.filter(
      (t) => /call this FIRST/i.test(t.description) && !PRIMARY_MCP_TOOLS.has(t.name),
    ).map((t) => t.name);
    expect(hidden).toEqual([]);
  });
});

describe('columnar legend honesty (M2)', () => {
  // The legend must document the `derived` block tableToColumnar can emit;
  // a strict decoder that only knew cols/rows/absent/dict silently loses any
  // column dropped as a pure function of a kept one.
  test('COLUMNAR_LEGEND documents the derived block', () => {
    expect(COLUMNAR_LEGEND).toContain('derived');
  });

  test.each(['const', 'prefix', 'basename'])(
    'COLUMNAR_LEGEND documents the %s derived op',
    (op) => {
      expect(COLUMNAR_LEGEND).toContain(op);
    },
  );
});
