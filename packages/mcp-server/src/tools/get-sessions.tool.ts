import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IToolDefinition } from '../server/tool-definition.ts';

function sessionsDir(root: string): string {
  return nodePath.join(root, '.sharkcraft', 'sessions');
}

export const getSessionsTool: IToolDefinition = {
  name: 'get_sessions',
  description: 'List local SharkCraft audit sessions (read-only). Each id is a folder under .sharkcraft/sessions/.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const dir = sessionsDir(ctx.inspection.projectRoot);
    if (!existsSync(dir)) return { data: { sessions: [] } };
    const entries = readdirSync(dir)
      .filter((d) => statSync(nodePath.join(dir, d)).isDirectory())
      .sort()
      .reverse();
    return { data: { sessions: entries.map((id) => ({ id })) } };
  },
};

export const getSessionTool: IToolDefinition = {
  name: 'get_session',
  description: 'Read one local session by id. Returns task.md, action-hints.json metadata, and attached plan filenames.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const dir = nodePath.join(sessionsDir(ctx.inspection.projectRoot), id);
    if (!existsSync(dir)) return { isError: true, text: `No session "${id}".` };
    const taskPath = nodePath.join(dir, 'task.md');
    const plansDir = nodePath.join(dir, 'plans');
    const plans = existsSync(plansDir) ? readdirSync(plansDir) : [];
    const task = existsSync(taskPath) ? readFileSync(taskPath, 'utf8') : '';
    return { data: { id, dir, task: task.trim(), plans } };
  },
};
