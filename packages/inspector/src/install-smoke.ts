/**
 * `shrk install smoke` — verify the installed CLI is callable.
 *
 * Declares a deterministic plan of safe commands to run after install (no
 * network, no shell tricks). The CLI command runs each plan step with the
 * inherited environment and reports pass/fail per step.
 *
 * Plan steps:
 *  - resolve the local `shrk` binary
 *  - shrk version
 *  - shrk help
 *  - shrk commands primary
 *  - shrk runtime doctor
 *  - shrk release readiness (only if inside the SharkCraft repo)
 */

export const INSTALL_SMOKE_SCHEMA = 'sharkcraft.install-smoke/v1';

export interface IInstallSmokeStep {
  id: string;
  title: string;
  command: readonly string[];
  /** When true, failure is non-fatal. */
  optional?: boolean;
  /** When set, the step is only attempted if running inside the SharkCraft repo. */
  requiresRepo?: boolean;
}

export interface IInstallSmokeStepResult {
  step: IInstallSmokeStep;
  status: 'pass' | 'fail' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  reason?: string;
}

export interface IInstallSmokeReport {
  schema: typeof INSTALL_SMOKE_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  isSharkcraftRepo: boolean;
  steps: readonly IInstallSmokeStepResult[];
  ok: boolean;
}

const PLAN: readonly IInstallSmokeStep[] = [
  { id: 'version', title: 'shrk version', command: ['shrk', 'version'] },
  { id: 'help', title: 'shrk help', command: ['shrk', '--help'], optional: true },
  { id: 'primary', title: 'shrk commands primary', command: ['shrk', 'commands', 'primary'] },
  { id: 'runtime-doctor', title: 'shrk runtime doctor', command: ['shrk', 'runtime', 'doctor'], optional: true },
  {
    id: 'release-readiness',
    title: 'shrk release readiness',
    command: ['shrk', 'release', 'readiness'],
    requiresRepo: true,
  },
];

export function getInstallSmokePlan(): readonly IInstallSmokeStep[] {
  return PLAN;
}
