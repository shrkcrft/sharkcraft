/**
 * Read-only MCP tools for task routing hints + pack helpers.
 */
import {
  explainTaskRouting,
  findPackHelper,
  listPackHelpers,
  listTaskRoutingHints,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listTaskRoutingHintsTool: IToolDefinition = {
  name: 'list_task_routing_hints',
  description: 'List pack/local task routing hints. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    return { data: await listTaskRoutingHints(ctx.inspection) };
  },
};

export const explainTaskRoutingTool: IToolDefinition = {
  name: 'explain_task_routing',
  description:
    'Explain which routing hints fire for a task. **For agent first-task grounding prefer `prepare_agent_task`**; use this when you only need the routing trace. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['task'],
    properties: { task: { type: 'string' } },
  },
  async handler(input, ctx) {
    const task = typeof input.task === 'string' ? (input.task as string) : '';
    return { data: { task, matches: await explainTaskRouting(ctx.inspection, task) } };
  },
};

export const listHelpersTool: IToolDefinition = {
  // Renamed from `list_helpers` to dedup with the helper-registry tool;
  // both used to register under the same name. The alias on the import side
  // (`listPackHelpersTool`) was already pointing here.
  name: 'list_pack_helpers',
  description: 'List pack/local-contributed helpers. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { source: { type: 'string' } },
  },
  async handler(input, ctx) {
    let entries = await listPackHelpers(ctx.inspection);
    if (typeof input.source === 'string') entries = entries.filter((e) => e.source === input.source);
    return { data: entries };
  },
};

export const getHelperTool: IToolDefinition = {
  name: 'get_helper',
  description: 'Get one pack/local-contributed helper by id. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = typeof input.id === 'string' ? (input.id as string) : '';
    if (!id) return { isError: true, error: { code: 'invalid-input', message: 'id required' } };
    const entry = await findPackHelper(ctx.inspection, id);
    if (!entry) return { isError: true, error: { code: 'not-found', message: `Unknown helper "${id}".` } };
    return { data: entry };
  },
};
