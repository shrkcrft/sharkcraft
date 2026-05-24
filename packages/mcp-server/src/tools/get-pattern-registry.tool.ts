import { PatternRegistryStore } from '@shrkcrft/structural-search';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * Read-only MCP mirror of `shrk search-structural registry list`.
 * Returns the full registry payload — the agent can pick a pattern by
 * id and reference it in subsequent `get_structural_search` calls.
 */
export const getPatternRegistryTool: IToolDefinition = {
  name: 'get_pattern_registry',
  description:
    'Return the persistent registry of reusable structural-search patterns. Read-only.',
  cliCommand: 'search-structural registry list',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler(_input, ctx) {
    const store = new PatternRegistryStore(ctx.inspection.projectRoot);
    if (!store.exists()) {
      return {
        data: {
          schema: 'sharkcraft.structural-pattern-registry/v1',
          present: false,
          path: store.absPath,
          patterns: [],
          nextCommands: ['shrk search-structural registry seed', 'shrk search-structural registry add'],
        },
      };
    }
    const reg = store.read();
    return {
      data: {
        schema: reg.schema,
        present: true,
        path: store.absPath,
        patterns: reg.patterns,
        total: reg.patterns.length,
      },
    };
  },
};
