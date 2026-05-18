import type { IToolDefinition } from '../server/tool-definition.ts';
import { buildContext } from '@shrkcrft/context';
import { buildProjectOverview, renderOverviewText } from '@shrkcrft/inspector';

export const getRelevantContextTool: IToolDefinition = {
  name: 'get_relevant_context',
  description:
    'Build a token-budgeted, AI-ready context for a task — relevant rules/paths/templates/etc. **Prefer `prepare_agent_task` for first task grounding** (it returns this plus action hints + safety + next-command). Use this when you only need the context body. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      framework: { type: 'string' },
      area: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      scope: { type: 'array', items: { type: 'string' } },
      maxTokens: { type: 'integer', minimum: 100 },
      includeExamples: { type: 'boolean' },
      includeTemplates: { type: 'boolean' },
      includeRules: { type: 'boolean' },
      includePaths: { type: 'boolean' },
      includeDocs: { type: 'boolean' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const overview = buildProjectOverview(ctx.inspection.workspace, ctx.inspection.config?.projectName);
    const result = buildContext(ctx.inspection.knowledgeEntries, {
      task: String(input.task),
      framework: typeof input.framework === 'string' ? input.framework : undefined,
      area: typeof input.area === 'string' ? input.area : undefined,
      tags: input.tags as string[] | undefined,
      scope: input.scope as string[] | undefined,
      maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : undefined,
      includeExamples: input.includeExamples as boolean | undefined,
      includeTemplates: input.includeTemplates as boolean | undefined,
      includeRules: input.includeRules as boolean | undefined,
      includePaths: input.includePaths as boolean | undefined,
      includeDocs: input.includeDocs as boolean | undefined,
      projectOverview: renderOverviewText(overview),
    });
    return {
      text: result.body,
      data: {
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
    };
  },
};
