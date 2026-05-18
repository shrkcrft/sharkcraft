import type { IToolDefinition } from '../server/tool-definition.ts';
import { buildContext } from '@shrkcrft/context';
import { buildProjectOverview, renderOverviewText } from '@shrkcrft/inspector';
import { formatPipelineFull } from '@shrkcrft/pipelines';

export const getPipelineContextTool: IToolDefinition = {
  name: 'get_pipeline_context',
  description:
    'Combine a pipeline with task-specific retrieved context. Returns the pipeline definition + a token-budgeted context block for the task. Use this when the agent has chosen a pipeline and needs both the workflow steps and the relevant rules/paths/templates to follow it.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      task: { type: 'string' },
      maxTokens: { type: 'integer', minimum: 100 },
      scope: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const pipeline = ctx.inspection.pipelineRegistry.get(id);
    if (!pipeline) return { isError: true, text: `No pipeline with id "${id}".` };

    const overview = buildProjectOverview(ctx.inspection.workspace, ctx.inspection.config?.projectName);
    const result = buildContext(ctx.inspection.knowledgeEntries, {
      task: String(input.task),
      scope: input.scope as string[] | undefined,
      maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : 3000,
      projectOverview: renderOverviewText(overview),
    });

    return {
      data: {
        pipeline,
        context: {
          totalTokens: result.totalTokens,
          maxTokens: result.maxTokens,
          omittedSections: result.omittedSections,
          sections: result.sections.map((s) => ({
            title: s.title,
            tokens: s.tokens,
            truncated: s.truncated ?? false,
            entryIds: s.entryIds,
          })),
        },
      },
      text: `${formatPipelineFull(pipeline)}\n\n---\n\n${result.body}`,
    };
  },
};
