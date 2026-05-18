import {
  buildPlaybookPreview,
  buildPlaybookScript,
  loadPlaybooks,
  validatePlaybook,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const previewPlaybookScriptTool: IToolDefinition = {
  name: 'preview_playbook_script',
  description:
    'Preview a playbook as a structured plan + bash-style script. SharkCraft never executes the script. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' }, task: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = String(input['id'] ?? '');
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : undefined;
    const playbooks = await loadPlaybooks(ctx.inspection);
    const p = playbooks.find((x) => x.id === id);
    if (!p) return { error: { code: 'not-found', message: `No playbook "${id}"` } };
    return {
      data: {
        preview: buildPlaybookPreview(p),
        script: buildPlaybookScript(p, task ? { task } : {}),
        validation: validatePlaybook(p, ctx.inspection),
      },
    };
  },
};
