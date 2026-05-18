import * as nodePath from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildContradictionReport,
  buildGeneratedCodeReport,
  buildRepositoryKnowledgeModel,
  buildTaskPacket,
  buildTaskRiskReport,
  classifyChangeIntent,
  getChangedFiles,
  isGitRepo,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const understandTaskTool: IToolDefinition = {
  name: 'understand_task',
  description:
    'Return task-specific context (intent + relevant rules + likely files + risks + recommended commands). **Prefer `prepare_agent_task` for first task grounding** — it bundles this with safety notes + next-safe-action. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: { type: 'string' },
      presets: { type: 'array', items: { type: 'string' } },
    },
    required: ['task'],
  },
  async handler(input, ctx) {
    const task = typeof input.task === 'string' ? input.task : '';
    if (!task) {
      return { isError: true, error: { code: 'bad-input', message: 'task is required' } };
    }
    const packet = buildTaskPacket(ctx.inspection, task);
    const intent = await classifyChangeIntent(task, ctx.inspection);
    const risk = await buildTaskRiskReport(task, ctx.inspection);
    const presets = Array.isArray(input.presets) ? (input.presets as string[]).filter((s) => typeof s === 'string') : undefined;
    const model = await buildRepositoryKnowledgeModel({
      inspection: ctx.inspection,
      task,
      forcedPresetIds: presets,
    });
    return {
      text: nextHint('shrk understand-task "<task>"'),
      data: {
        task,
        intent,
        relevantRules: packet.relevantRules.map((r) => ({ id: r.id, title: r.title })),
        relevantPaths: packet.relevantPaths.map((p) => ({ id: p.id, title: p.title })),
        relevantTemplates: packet.relevantTemplates.map((t) => ({ id: t.id })),
        risks: risk.reasons.map((r) => r.message),
        riskLevel: risk.riskLevel,
        requiredValidations: packet.recommendedCliCommands,
        recommendedPipelineId: packet.recommendedPipelines[0]?.pipelineId ?? null,
        modelPresetIds: model.presets.map((p) => p.preset.id),
        transformationalIntents: model.transformationalIntents,
      },
    };
  },
};

export const getTaskContextTool: IToolDefinition = {
  name: 'get_task_context',
  description: 'Return the most recently saved task context bundle (under .sharkcraft/context/). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { task: { type: 'string' } },
  },
  handler(input, ctx) {
    const baseDir = nodePath.join(ctx.cwd, '.sharkcraft', 'context');
    const statusFile = nodePath.join(baseDir, 'status.json');
    if (!existsSync(statusFile)) {
      return { isError: true, error: { code: 'not-found', message: 'No task context yet — run `shrk context build --task "..."` first.' } };
    }
    const status = JSON.parse(readFileSync(statusFile, 'utf8')) as { lastTask?: string };
    const taskSlug = typeof input.task === 'string'
      ? input.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 60)
      : status.lastTask
        ? status.lastTask.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 60)
        : '';
    if (!taskSlug) {
      return { isError: true, error: { code: 'not-found', message: 'No task slug to look up.' } };
    }
    const jsonFile = nodePath.join(baseDir, 'task-contexts', `${taskSlug}.json`);
    if (!existsSync(jsonFile)) {
      return { isError: true, error: { code: 'not-found', message: `No bundle for ${taskSlug}` } };
    }
    return {
      text: nextHint('shrk context build --task "<task>"'),
      data: JSON.parse(readFileSync(jsonFile, 'utf8')),
    };
  },
};

export const validateChangeContextTool: IToolDefinition = {
  name: 'validate_change_context',
  description: 'Inspect a proposed/staged change for boundary violations, generated-code edits, missing tests, doc contradictions. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      files: { type: 'array', items: { type: 'string' } },
      since: { type: 'string' },
      staged: { type: 'boolean' },
    },
  },
  async handler(input, ctx) {
    const filesIn = Array.isArray(input.files) ? (input.files as string[]).filter((f) => typeof f === 'string') : [];
    const since = typeof input.since === 'string' ? input.since : undefined;
    const staged = input.staged === true;
    let changed = filesIn;
    if (changed.length === 0 && isGitRepo(ctx.cwd)) {
      changed = getChangedFiles(ctx.cwd, { staged, ...(since ? { since } : {}) });
    }
    const contradictions = buildContradictionReport({ inspection: ctx.inspection });
    const generated = buildGeneratedCodeReport({ inspection: ctx.inspection });
    const generatedPaths = new Set(generated.generatedFiles.map((f) => f.path));
    const boundaryHits = changed.filter((f) => /(^|\/)packages\/[^\/]+\/src\/index\.(ts|tsx|js)$/.test(f));
    const generatedHits = changed.filter((f) => generatedPaths.has(f) || f.endsWith('.d.ts'));
    const docContradictions = contradictions.findings.filter((c) => changed.includes(c.source));
    return {
      text: nextHint('shrk validate-change --staged'),
      data: {
        changedFiles: changed,
        boundaryHits,
        generatedHits,
        docContradictions: docContradictions.map((c) => ({ source: c.source, line: c.line, message: c.message })),
        verdict: boundaryHits.length === 0 && generatedHits.length === 0 ? 'pass' : 'review',
      },
    };
  },
};
