import type { IToolDefinition } from '../server/tool-definition.ts';
import { interpolatePipeline, renderPipelineScript } from '@shrkcrft/pipelines';

export const createPipelinePlanTool: IToolDefinition = {
  name: 'create_pipeline_plan',
  description:
    'Resolve a pipeline against a task + named inputs and return the interpolated step list. Optionally include a copy-pasteable shell script (apply/write steps include a manual-confirm prompt). Never executes anything.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      task: { type: 'string' },
      inputs: { type: 'object', additionalProperties: { type: 'string' } },
      includeOptional: { type: 'array', items: { type: 'string' } },
      includeScript: { type: 'boolean' },
    },
    required: ['id', 'task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const pipeline = ctx.inspection.pipelineRegistry.get(id);
    if (!pipeline) return { isError: true, text: `No pipeline with id "${id}".` };

    const interp = interpolatePipeline(pipeline, {
      task: String(input.task),
      projectRoot: ctx.inspection.projectRoot,
      inputs: (input.inputs as Record<string, string> | undefined) ?? {},
      includeOptional: (input.includeOptional as string[] | undefined) ?? [],
    });
    const data: Record<string, unknown> = {
      pipelineId: pipeline.id,
      title: pipeline.title,
      description: pipeline.description,
      task: interp.task,
      inputs: interp.inputs,
      steps: interp.steps,
    };
    if (input.includeScript === true) {
      data.script = renderPipelineScript(interp);
    }
    return { data };
  },
};
