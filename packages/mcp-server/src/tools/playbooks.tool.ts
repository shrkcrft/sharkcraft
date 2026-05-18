import { loadPlaybooks, recommendPlaybooks } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listPlaybooksTool: IToolDefinition = {
  name: 'list_playbooks',
  description: 'List registered playbooks. Read-only.',
  inputSchema: { type: 'object', properties: {} },
  async handler(_input, ctx) {
    const list = await loadPlaybooks(ctx.inspection);
    return { data: list };
  },
};

export const getPlaybookTool: IToolDefinition = {
  name: 'get_playbook',
  description: 'Show a single playbook. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = String(input['id'] ?? '');
    const list = await loadPlaybooks(ctx.inspection);
    const p = list.find((x) => x.id === id);
    if (!p) return { error: { code: 'not-found', message: `No playbook "${id}"` } };
    return { data: p };
  },
};

export const recommendPlaybooksTool: IToolDefinition = {
  name: 'recommend_playbooks',
  description: 'Recommend playbooks for a task. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['task'],
    properties: { task: { type: 'string' }, limit: { type: 'number' } },
  },
  async handler(input, ctx) {
    const task = String(input['task'] ?? '');
    const limit = typeof input['limit'] === 'number' ? (input['limit'] as number) : 5;
    const list = await loadPlaybooks(ctx.inspection);
    const recs = recommendPlaybooks(list, task);
    return { data: recs.slice(0, limit) };
  },
};
