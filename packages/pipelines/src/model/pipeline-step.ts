/**
 * Step type taxonomy. Steps are declarative; SharkCraft does not run them.
 * Pipelines are retrieval-shaped so an agent can read the plan and follow it.
 */
export enum PipelineStepType {
  /** Build / load context (no side effects). */
  Context = 'context',
  /** Agent-driven thinking step (instruction-only). */
  Agent = 'agent',
  /** Produce a generation plan (dry-run only via MCP / CLI gen --dry-run). */
  GenerationPlan = 'generation-plan',
  /** Apply a saved plan (CLI-only). */
  ApplyPlan = 'apply-plan',
  /** Run a shell command. */
  Command = 'command',
  /** Call an MCP tool. */
  McpTool = 'mcp-tool',
}

export interface IPipelineStep {
  id: string;
  /** Step type — gives the agent a clear class of action. */
  type: PipelineStepType | string;
  /** Short description shown alongside the step. */
  description?: string;
  /** MCP tool names referenced by this step. */
  mcpTools?: readonly string[];
  /** CLI command strings (with <placeholder> tokens). */
  cliCommands?: readonly string[];
  /** Agent instruction text (for type=agent). */
  instruction?: string;
  /** Default true: this step must run for the pipeline to succeed. */
  required?: boolean;
  /** True if a human must review the result before continuing. */
  humanReview?: boolean;
  /**
   * Optional input name that gates this step. The CLI / MCP context builders
   * pass it through as informational metadata; v1 does not evaluate it.
   */
  enabledWhen?: string;
  /** Optional reference to a knowledge entry / template / path convention. */
  references?: readonly string[];
}
