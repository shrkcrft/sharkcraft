import { PipelineStepType } from '@shrkcrft/pipelines';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/**
 * Resolve the verification commands an agent should run after a task, grounded
 * in the pack rather than a generic default. Precedence (first non-empty wins):
 *
 *   1. The matched pipeline's command-type gate steps — the gates the pipeline
 *      author actually declared for this class of work (e.g. the engine
 *      `feature-dev` pipeline's `bun x tsc … --noEmit` + `bun test`).
 *   2. The project's `sharkcraft.config.ts verificationCommands[]` — the
 *      trusted, repo-wide gate set (the same source `apply --validate` runs).
 *   3. The caller-supplied knowledge action-hint defaults — today's behaviour,
 *      used only when neither of the above declares anything.
 *
 * A pipeline gate is a `command`-type step that is required and carries a
 * concrete command (no `<placeholder>` tokens) — this excludes optional review
 * steps, context builds, and generative/spec steps (which take arguments) while
 * keeping the real post-change gates. Rules carry no verification field, so
 * they are intentionally not a source here.
 *
 * Deterministic, order-preserving, deduped. No commands are executed.
 */
export function resolveVerificationCommands(
  inspection: ISharkcraftInspection,
  options: {
    readonly pipelineIds?: readonly string[];
    readonly knowledgeDefaults?: readonly string[];
  } = {},
): string[] {
  const fromPipelines: string[] = [];
  for (const id of options.pipelineIds ?? []) {
    const pipeline = inspection.pipelineRegistry.get(id);
    if (!pipeline) continue;
    for (const step of pipeline.steps) {
      if (step.type !== PipelineStepType.Command) continue;
      if (step.required === false) continue;
      for (const raw of step.cliCommands ?? []) {
        const cmd = raw.trim();
        if (cmd.length > 0 && !cmd.includes('<')) fromPipelines.push(cmd);
      }
    }
  }
  if (fromPipelines.length > 0) return dedupe(fromPipelines);

  const cfg = inspection.config as
    | { verificationCommands?: ReadonlyArray<{ command?: string }> }
    | null;
  const fromConfig: string[] = [];
  for (const vc of cfg?.verificationCommands ?? []) {
    const cmd = vc?.command?.trim();
    if (cmd && cmd.length > 0) fromConfig.push(cmd);
  }
  if (fromConfig.length > 0) return dedupe(fromConfig);

  return dedupe(options.knowledgeDefaults ?? []);
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}
