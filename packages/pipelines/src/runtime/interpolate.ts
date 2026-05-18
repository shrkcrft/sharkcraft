import type { IPipelineDefinition } from '../model/pipeline-definition.ts';
import type { IPipelineStep } from '../model/pipeline-step.ts';

export interface IInterpolatedStep {
  id: string;
  type: string;
  description?: string;
  instruction?: string;
  mcpTools: readonly string[];
  cliCommands: readonly string[];
  references: readonly string[];
  required: boolean;
  humanReview: boolean;
  enabledWhen?: string;
  /** True if this step was skipped because of enabledWhen and the user did not opt in. */
  skipped: boolean;
}

export interface IInterpolatedPipeline {
  id: string;
  title: string;
  description: string;
  task: string;
  inputs: Record<string, string>;
  steps: IInterpolatedStep[];
}

export interface InterpolatePipelineOptions {
  task: string;
  projectRoot?: string;
  /** Named inputs passed by the agent / user. */
  inputs?: Record<string, string>;
  /** Set of optional step ids to include. Pass '*' to include all optional steps. */
  includeOptional?: readonly string[];
}

function applyPlaceholders(input: string, values: Record<string, string>): string {
  return input.replace(/<([a-zA-Z][a-zA-Z0-9_-]*)>/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key]!;
    return whole;
  });
}

/**
 * Interpolate placeholders in the pipeline's CLI commands / instructions /
 * descriptions. Returns the resolved step list and a record of every value
 * used (for traceability).
 *
 * Placeholders supported:
 *  - <task>          → options.task
 *  - <repo>          → options.projectRoot
 *  - <pipelineId>    → the pipeline id
 *  - <name>          → options.inputs.name etc.
 *
 * Optional steps (`required: false`) are dropped unless their id is listed in
 * `includeOptional` (or `*`). Steps with `enabledWhen` are dropped unless
 * `enabledWhen` is included in `includeOptional`.
 */
export function interpolatePipeline(
  pipeline: IPipelineDefinition,
  options: InterpolatePipelineOptions,
): IInterpolatedPipeline {
  const values: Record<string, string> = {
    task: options.task,
    repo: options.projectRoot ?? '<repo>',
    pipelineId: pipeline.id,
    ...(options.inputs),
  };
  const includeAll = options.includeOptional?.includes('*') === true;
  const includeSet = new Set(options.includeOptional ?? []);

  function resolveStep(step: IPipelineStep): IInterpolatedStep {
    const requiredDefault = step.required !== false;
    let skipped = false;
    if (!requiredDefault && !includeAll && !includeSet.has(step.id)) {
      skipped = true;
    }
    if (step.enabledWhen && !includeAll && !includeSet.has(step.enabledWhen) && !includeSet.has(step.id)) {
      skipped = true;
    }
    const out: IInterpolatedStep = {
      id: step.id,
      type: step.type as string,
      required: requiredDefault,
      humanReview: step.humanReview === true,
      mcpTools: step.mcpTools ?? [],
      cliCommands: (step.cliCommands ?? []).map((c: string) => applyPlaceholders(c, values)),
      references: step.references ?? [],
      skipped,
    };
    if (step.description !== undefined) out.description = applyPlaceholders(step.description, values);
    if (step.instruction !== undefined) out.instruction = applyPlaceholders(step.instruction, values);
    if (step.enabledWhen !== undefined) out.enabledWhen = step.enabledWhen;
    return out;
  }

  return {
    id: pipeline.id,
    title: pipeline.title,
    description: pipeline.description,
    task: options.task,
    inputs: values,
    steps: pipeline.steps.map(resolveStep),
  };
}
