/**
 * Read-only MCP tools for ranker explainability.
 *
 * `get_ranker_explanation` answers "why was id X included for task Y?".
 * `get_ranker_why_not` answers "why wasn't id X included for task Y?".
 *
 * Both are read-only. No writes; the CLI is the only write path.
 */
import { explainRankerDecision, type IRankerExplainRequest } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(id: string, task: string | undefined, whyNot: boolean): string {
  const cmd = whyNot ? 'why-not' : 'why';
  const t = task ? ` --for-task "${task}"` : '';
  return `Next: \`shrk ${cmd} ${id}${t}\` (CLI is the only write path).`;
}

const REQUEST_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string' as const, description: 'Target id to explain.' },
    task: { type: 'string' as const, description: 'Free-form task description.' },
    query: { type: 'string' as const, description: 'Free-form search query.' },
    kind: {
      type: 'string' as const,
      description:
        'Optional kind hint (knowledge|template|rule|helper|playbook|construct|policy|command|path|preset|pipeline).',
    },
    topN: { type: 'number' as const, description: 'Top-N considered for inclusion. Default 10.' },
  },
};

export const getRankerExplanationTool: IToolDefinition = {
  name: 'get_ranker_explanation',
  description:
    'Explain how the deterministic ranker scored an id for a given task or query. Returns matched/missing signals, score, rank, outranked-by, suggested metadata fixes. Read-only.',
  inputSchema: REQUEST_SCHEMA,
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const task = typeof input.task === 'string' ? input.task : undefined;
    const query = typeof input.query === 'string' ? input.query : undefined;
    const kindRaw = typeof input.kind === 'string' ? input.kind : undefined;
    const topN = typeof input.topN === 'number' ? input.topN : 10;
    const request: IRankerExplainRequest = {
      id,
      ...(task ? { task } : {}),
      ...(query ? { query } : {}),
      ...(kindRaw ? { kind: kindRaw as IRankerExplainRequest['kind'] } : {}),
    };
    const report = explainRankerDecision(ctx.inspection, request, { whyNot: false, topN });
    return { text: nextHint(id, task, false), data: report };
  },
};

export const getRankerWhyNotTool: IToolDefinition = {
  name: 'get_ranker_why_not',
  description:
    'Explain why the deterministic ranker did NOT include an id for a given task or query. Returns nearest ids when the target is missing entirely. Read-only.',
  inputSchema: REQUEST_SCHEMA,
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const task = typeof input.task === 'string' ? input.task : undefined;
    const query = typeof input.query === 'string' ? input.query : undefined;
    const kindRaw = typeof input.kind === 'string' ? input.kind : undefined;
    const topN = typeof input.topN === 'number' ? input.topN : 10;
    const request: IRankerExplainRequest = {
      id,
      ...(task ? { task } : {}),
      ...(query ? { query } : {}),
      ...(kindRaw ? { kind: kindRaw as IRankerExplainRequest['kind'] } : {}),
    };
    const report = explainRankerDecision(ctx.inspection, request, { whyNot: true, topN });
    return { text: nextHint(id, task, true), data: report };
  },
};
