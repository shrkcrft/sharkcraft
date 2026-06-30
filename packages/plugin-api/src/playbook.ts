/**
 * Playbooks: named, reusable human/agent recipes. A playbook bundles a
 * preset, a pipeline, recommended templates, and a step-by-step runbook
 * with optional verification commands and safety notes. They're the
 * generic equivalent of older project-specific recipes without baking
 * those into the SharkCraft engine.
 *
 * Playbooks are NEVER auto-executed; they are structured runbooks that the
 * agent or human reads and follows.
 */

export interface IPlaybookStep {
  id: string;
  title: string;
  description?: string;
  /** Shell commands to run (read-only / non-destructive recommended). */
  commands?: readonly string[];
  /** MCP tools to call to discover context. */
  mcpTools?: readonly string[];
  /** When true, this step requires explicit human review before continuing. */
  humanReview?: boolean;
  /**
   * Commands the human should run to validate the step's effect.
   *
   * To stay package-manager-agnostic, prefer the templating placeholders over
   * hard-coding a runner: `<pm-run>` is substituted with the consuming
   * project's run-prefix (`bun run` / `npm run` / `pnpm` / `yarn`) and `<pm>`
   * with the bare manager name (`bun` / `npm` / `pnpm` / `yarn`) at consume
   * time. For example, ship `<pm-run> test` rather than `bun test` so the
   * command resolves to the target repo's real toolchain instead of whichever
   * ecosystem the pack author happened to use. Hard-coded literals that
   * disagree with the detected toolchain are flagged (non-fatally) by
   * `shrk doctor packs`.
   */
  verificationCommands?: readonly string[];
  /** Free-form safety notes. */
  safetyNotes?: readonly string[];
}

export interface IPlaybookInput {
  id: string;
  title: string;
  description?: string;
  tags?: readonly string[];
  /** Task kinds this playbook is suitable for (e.g. 'generate', 'review'). */
  taskKinds?: readonly string[];
  recommendedPresetIds?: readonly string[];
  recommendedPipelineIds?: readonly string[];
  recommendedTemplateIds?: readonly string[];
  steps: readonly IPlaybookStep[];
  /** Expected outputs after the playbook completes. */
  outputs?: readonly string[];
  /** Example tasks the playbook addresses. */
  examples?: readonly string[];
}

export function definePlaybook(input: IPlaybookInput): IPlaybookInput {
  return input;
}
