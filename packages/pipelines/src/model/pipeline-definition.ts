import type { IPipelineInput } from './pipeline-input.ts';
import type { IPipelineStep } from './pipeline-step.ts';

export interface IPipelineDefinition {
  id: string;
  title: string;
  description: string;
  tags?: readonly string[];
  scope?: readonly string[];
  /** Free-form task hints (e.g. "generate-service"). Used for relevance lookup. */
  appliesWhen?: readonly string[];
  inputs?: readonly IPipelineInput[];
  steps: readonly IPipelineStep[];
  /** Free-form notes shown after the steps. */
  notes?: readonly string[];
  /** Originating file path. */
  source?: { origin?: string };
}

export type PipelineDefinitionInput = Omit<IPipelineDefinition, 'source'>;
