import { PipelineStepType } from '@shrkcrft/pipelines';
import {
  PackageManager,
  WorkspaceProfile,
  type IWorkspaceSummary,
} from '@shrkcrft/workspace';
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
 * Package-manager templating: any command may use a `<pm-run>` or `<pm>`
 * placeholder that is substituted with the project's detected package manager
 * at consume time (e.g. a pack playbook ships `<pm-run> test` and it resolves
 * to `bun run test` / `npm run test` / `pnpm test` per the target repo). The
 * substitution runs before the placeholder-exclusion check, so a templated
 * gate survives while a truly generative `<task>` step is still dropped.
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
  const ws = inspection.workspace;
  const fromPipelines: string[] = [];
  for (const id of options.pipelineIds ?? []) {
    const pipeline = inspection.pipelineRegistry.get(id);
    if (!pipeline) continue;
    for (const step of pipeline.steps) {
      if (step.type !== PipelineStepType.Command) continue;
      if (step.required === false) continue;
      for (const raw of step.cliCommands ?? []) {
        const cmd = substitutePmPlaceholders(raw.trim(), ws);
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
    const cmd = substitutePmPlaceholders(vc?.command?.trim() ?? '', ws);
    if (cmd.length > 0) fromConfig.push(cmd);
  }
  if (fromConfig.length > 0) return dedupe(fromConfig);

  return dedupe(
    (options.knowledgeDefaults ?? []).map((c) => substitutePmPlaceholders(c, ws)),
  );
}

/**
 * Replace package-manager placeholders in a single command with the project's
 * detected toolchain. `<pm-run>` → the run-prefix (`bun run`, `npm run`,
 * `pnpm`, `yarn`); `<pm>` → the bare manager name (`bun`, `npm`, `pnpm`,
 * `yarn`). A no-op (and zero workspace access) when the command carries no
 * `<pm` token, so non-templated callers and stubbed inspections are unaffected.
 */
function substitutePmPlaceholders(
  command: string,
  ws: IWorkspaceSummary | undefined,
): string {
  if (!command.includes('<pm')) return command;
  const manager = effectivePackageManager(ws);
  return command
    .replaceAll('<pm-run>', packageManagerRunPrefix(manager))
    .replaceAll('<pm>', bareManager(manager));
}

function effectivePackageManager(ws: IWorkspaceSummary | undefined): PackageManager {
  const detected = ws?.packageManager?.manager;
  if (detected && detected !== PackageManager.Unknown) return detected;
  if (ws?.profiles?.includes(WorkspaceProfile.HasBun)) return PackageManager.Bun;
  return PackageManager.Npm;
}

function packageManagerRunPrefix(manager: PackageManager): string {
  switch (manager) {
    case PackageManager.Bun:
      return 'bun run';
    case PackageManager.Pnpm:
      return 'pnpm';
    case PackageManager.Yarn:
      return 'yarn';
    case PackageManager.Npm:
      return 'npm run';
    default:
      return 'npm run';
  }
}

function bareManager(manager: PackageManager): string {
  return manager === PackageManager.Unknown ? 'npm' : manager;
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}
