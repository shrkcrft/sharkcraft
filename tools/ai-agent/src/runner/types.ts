import type { ISanitizedIssue } from '../sanitize.ts';
import type { IRepoContext } from '../context.ts';

export enum AgentMode {
  Plan = 'plan',
  Implement = 'implement',
}

export interface ITokenLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
  deadlineMs: number;
}

export interface IAgentRunInput {
  mode: AgentMode;
  issue: ISanitizedIssue;
  context: IRepoContext;
  limits: ITokenLimits;
  signal: AbortSignal;
}

export interface IAgentRunTelemetry {
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

export interface IAgentRunOutput {
  commentMarkdown: string;
  telemetry: IAgentRunTelemetry;
}

export interface IAgentRunner {
  run(input: IAgentRunInput): Promise<IAgentRunOutput>;
}
