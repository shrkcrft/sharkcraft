/**
 * Architecture-diff / risk MCP tools. All read-only.
 */
import {
  buildArchitectureViolationsDiff,
  buildTaskRiskReport,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getArchitectureViolationsDiffTool: IToolDefinition = {
  name: 'get_architecture_violations_diff',
  description:
    'Architecture violations diff (read-only). Scope/compare by `since`, `staged`, `files`, `baselineFile`.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'string' },
      staged: { type: 'boolean' },
      files: { type: 'array', items: { type: 'string' } },
      baselineFile: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const since = typeof input['since'] === 'string' ? (input['since'] as string) : undefined;
    const staged = input['staged'] === true;
    const baselineFile =
      typeof input['baselineFile'] === 'string' ? (input['baselineFile'] as string) : undefined;
    const files = Array.isArray(input['files'])
      ? (input['files'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const report = await buildArchitectureViolationsDiff(ctx.inspection, {
      ...(since ? { since } : {}),
      ...(staged ? { staged: true } : {}),
      ...(baselineFile ? { baselineFile } : {}),
      ...(files ? { files } : {}),
    });
    return { data: report };
  },
};

export const getTaskRiskReportTool: IToolDefinition = {
  name: 'get_task_risk_report',
  description:
    'Compute a per-task risk report (intent + impact + boundaries + ownership + tests + architecture signals). Read-only. `includeMemory` folds memory-weighted signals into the score.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      since: { type: 'string' },
      staged: { type: 'boolean' },
      includeMemory: { type: 'boolean' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : '';
    const files = Array.isArray(input['files'])
      ? (input['files'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const since = typeof input['since'] === 'string' ? (input['since'] as string) : undefined;
    const staged = input['staged'] === true;
    const includeMemory = input['includeMemory'] === true;
    const report = await buildTaskRiskReport(task, ctx.inspection, {
      ...(files ? { files } : {}),
      ...(since ? { since } : {}),
      ...(staged ? { staged: true } : {}),
      ...(includeMemory ? { includeMemory: true } : {}),
    });
    return { data: report };
  },
};
