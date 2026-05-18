/**
 * Canonical agent task entrypoint (read-only).
 *
 * Recommended first MCP call for AI agents picking up a task. Returns a
 * bundle of intent hints, recommended commands, relevant profiles /
 * conventions / routing hints, and the next safe action.
 */
import { prepareAgentTask } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const prepareAgentTaskTool: IToolDefinition = {
  name: 'prepare_agent_task',
  description:
    'Canonical agent task entrypoint — call this FIRST when an AI agent picks up a new task. Returns intent / confidence / recommended commands / relevant profiles & conventions / safety notes / next-safe-action. Read-only. Prefer this over `get_task_packet` or `get_relevant_context` for first task grounding. Recommended commands may include experimental verbs; consult `get_command_catalog` for per-command tier, or call `shrk surface enable <cmd>` on the host before invoking.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['task'],
    properties: { task: { type: 'string' } },
  },
  async handler(input, ctx) {
    const task = typeof input.task === 'string' ? (input.task as string) : '';
    if (!task) return { isError: true, error: { code: 'invalid-input', message: 'task is required' } };
    const packet = await prepareAgentTask(ctx.inspection, task);
    // Agents need to know that recommend results may
    // include experimental commands they cannot call directly. The
    // surface tier system is the source of truth; the snapshot in
    // `get_command_catalog` carries `tier` per command.
    return {
      data: {
        ...packet,
        gatingNotice:
          'Some recommended commands may be experimental in this repo. Confirm via `get_command_catalog` (each entry has a `tier` field) before invoking; enable via `shrk surface enable <cmd> --write` if needed.',
      },
    };
  },
};
