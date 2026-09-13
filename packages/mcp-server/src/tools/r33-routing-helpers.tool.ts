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

// Exported as `listPackHelpersTool` / `getPackHelperTool` — NOT the
// `listHelpersTool` / `getHelperTool` names `r28-helpers.tool.ts` already
// exports. With the shared names, the repo's own `mcp-tool-registered` wiring
// rule counted both files' exports as ONE token each, so dropping these two
// tools from ALL_TOOLS left it green (declared 282 / registered 284: the
// registered side held the import aliases, which no declared site produced).
// Distinct names make each tool its own declared token.
export const listPackHelpersTool: IToolDefinition = {
  // Wire name renamed from `list_helpers` to dedup with the helper-registry
  // tool; both used to register under the same name.
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

export const getPackHelperTool: IToolDefinition = {
  // Wire name renamed from `get_helper` to dedup with the helper-registry tool
  // in `r28-helpers.tool.ts`; both registered under the same name, and
  // `toolsByName` is last-wins, so the r28 tool was unreachable via
  // `tools/call` while `tools/list` advertised the name twice. Completes the
  // dedup pass that already renamed this file's `list_helpers` →
  // `list_pack_helpers`.
  name: 'get_pack_helper',
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
