import {
  buildTaskPacket,
  computeDevNextAction,
  listDevSessions,
  renderDevSessionFinalReport,
  scanDevSession,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * MCP tool: preview what a dev session would contain WITHOUT creating it.
 * Returns the task packet + the exact CLI command the human should run.
 *
 * Read-only by contract — MCP never writes.
 */
export const startDevSessionPreviewTool: IToolDefinition = {
  name: 'start_dev_session_preview',
  description:
    'Preview what `shrk dev start "<task>"` would produce, WITHOUT creating the session. ' +
    'Returns the task packet (recommended pipeline + templates + rules + verification commands + ' +
    'forbidden actions) and the exact CLI command the human should run. MCP never writes.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      maxTokens: { type: 'number', minimum: 100, maximum: 20000 },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = String((input as { task?: unknown }).task ?? '').trim();
    if (!task) return { isError: true, text: 'task is required' };
    const maxTokens = Number((input as { maxTokens?: unknown }).maxTokens ?? 3500);
    const packet = buildTaskPacket(ctx.inspection, task, { maxTokens });
    return {
      data: {
        task,
        recommendedPipeline: packet.recommendedPipelines[0] ?? null,
        recommendedPipelines: packet.recommendedPipelines,
        selectedTemplates: packet.relevantTemplates.slice(0, 5).map((t) => ({ id: t.id, name: t.name })),
        relevantRules: packet.relevantRules.slice(0, 5).map((r) => ({ id: r.id, title: r.title })),
        forbiddenActions: packet.forbiddenActions,
        verificationCommands: packet.verificationCommands,
        humanReviewPoints: packet.humanReviewPoints,
        suggestedGen: packet.suggestedGen ?? null,
        cliCommand: `shrk dev start "${task.replace(/"/g, '\\"')}"`,
        note:
          'This preview does NOT create a session. Run the cliCommand above to create one ' +
          'under .sharkcraft/sessions/. MCP is read-only by contract.',
      },
    };
  },
};

export const getDevSessionTool: IToolDefinition = {
  name: 'get_dev_session',
  description:
    'Read one dev session by id. Returns task, phase, plans, applied plans, validations, ' +
    'reports, and computed next action. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    if (!id) return { isError: true, text: 'id is required' };
    const load = scanDevSession(ctx.cwd, id);
    if (!load) return { isError: true, text: `No session "${id}".` };
    const next = computeDevNextAction(load);
    return {
      data: {
        id: load.id,
        dir: load.dir,
        task: load.task,
        legacy: load.legacy,
        state: load.state,
        plansOnDisk: load.plansOnDisk,
        reportsOnDisk: load.reportsOnDisk,
        intentFiles: load.intentFiles,
        nextAction: next,
      },
    };
  },
};

export const getDevStatusTool: IToolDefinition = {
  name: 'get_dev_status',
  description:
    'Get the high-level status of a dev session: phase, plan counts, validation status, ' +
    'and the next recommended action. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    if (!id) return { isError: true, text: 'id is required' };
    const load = scanDevSession(ctx.cwd, id);
    if (!load) return { isError: true, text: `No session "${id}".` };
    const next = computeDevNextAction(load);
    return {
      data: {
        id: load.id,
        task: load.task,
        legacy: load.legacy,
        phase: load.state?.phase ?? null,
        plansCount: load.state?.plans.length ?? load.plansOnDisk.length,
        intentsCount: load.intentFiles.length,
        reviewedCount:
          load.state?.plans.filter((p) => p.status === 'reviewed').length ??
          load.reportsOnDisk.filter((r) => r.startsWith('plan-review-')).length,
        validationsCount: load.state?.validations.length ?? 0,
        appliedCount: load.state?.appliedPlans.length ?? 0,
        warnings: load.state?.warnings ?? [],
        nextAction: next,
      },
    };
  },
};

export const getDevNextActionTool: IToolDefinition = {
  name: 'get_dev_next_action',
  description:
    'Compute the safe next CLI command for an existing dev session: dev plan, plan review, ' +
    'apply, dev validate, or dev report. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    if (!id) return { isError: true, text: 'id is required' };
    const load = scanDevSession(ctx.cwd, id);
    if (!load) return { isError: true, text: `No session "${id}".` };
    return { data: computeDevNextAction(load) };
  },
};

export const getDevReportTool: IToolDefinition = {
  name: 'get_dev_report',
  description:
    'Render the dev session final report (Markdown) WITHOUT writing it. Use shrk dev report ' +
    '<id> to persist. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    if (!id) return { isError: true, text: 'id is required' };
    const load = scanDevSession(ctx.cwd, id);
    if (!load) return { isError: true, text: `No session "${id}".` };
    const next = computeDevNextAction(load);
    const md = renderDevSessionFinalReport(load, {
      nextActionLine: `${next.action} — \`${next.command}\``,
    });
    return { data: { id: load.id, markdown: md, nextAction: next } };
  },
};

export const listDevSessionsTool: IToolDefinition = {
  name: 'list_dev_sessions',
  description: 'List all dev session ids under .sharkcraft/sessions/. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    const ids = listDevSessions(ctx.cwd);
    return { data: { sessions: ids.map((id) => ({ id })) } };
  },
};
