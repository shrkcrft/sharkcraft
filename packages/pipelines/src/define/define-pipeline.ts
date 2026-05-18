import type {
  IPipelineDefinition,
  PipelineDefinitionInput,
} from '../model/pipeline-definition.ts';

export function definePipeline(input: PipelineDefinitionInput): IPipelineDefinition {
  if (!input.id) throw new Error("definePipeline: 'id' is required");
  if (!input.title) throw new Error(`definePipeline: 'title' is required for ${input.id}`);
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error(`definePipeline: ${input.id} must have at least one step`);
  }
  const ids = new Set<string>();
  for (const step of input.steps) {
    if (!step.id) {
      throw new Error(`definePipeline: ${input.id}: every step needs an id`);
    }
    if (ids.has(step.id)) {
      throw new Error(`definePipeline: ${input.id}: duplicate step id "${step.id}"`);
    }
    ids.add(step.id);
  }
  return {
    ...input,
    tags: input.tags ? Object.freeze([...input.tags]) : undefined,
    scope: input.scope ? Object.freeze([...input.scope]) : undefined,
    appliesWhen: input.appliesWhen ? Object.freeze([...input.appliesWhen]) : undefined,
    inputs: input.inputs ? Object.freeze([...input.inputs]) : undefined,
    steps: Object.freeze([...input.steps]),
    notes: input.notes ? Object.freeze([...input.notes]) : undefined,
  };
}
