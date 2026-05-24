import type { RewriteRecipe, StructuralPattern } from '@shrkcrft/structural-search';

export const MIGRATION_SCHEMA = 'sharkcraft.migration/v1' as const;
export const MIGRATION_RUN_SCHEMA = 'sharkcraft.migration-run/v1' as const;

/**
 * Ordered list of steps. Each step is one of:
 *
 *   - `structural-rewrite`: pair of (pattern, recipe) consumed by
 *     `@shrkcrft/structural-search`. The most common step kind.
 *   - `shell`: a literal shell command. Useful for `bun install`,
 *     `bun run build`, version bumps, etc.
 *   - `check`: a CLI command whose exit code gates the migration.
 *     Same as `shell` but the runner records a pass/fail per step.
 */
export type MigrationStep =
  | {
      kind: 'structural-rewrite';
      id?: string;
      description?: string;
      pattern: StructuralPattern;
      recipe: RewriteRecipe;
    }
  | {
      kind: 'shell';
      id?: string;
      description?: string;
      /** Shell command line. Run via bash -c. */
      command: string;
      /** Working directory relative to project root. */
      cwd?: string;
    }
  | {
      kind: 'check';
      id?: string;
      description?: string;
      command: string;
      cwd?: string;
    };

export interface IMigration {
  schema: typeof MIGRATION_SCHEMA;
  /** Stable migration id (used to look it up on disk). */
  id: string;
  /** Display title. */
  title: string;
  /** Optional human description. */
  description?: string;
  /** Steps run in this order. */
  steps: readonly MigrationStep[];
}

export type StepStatus = 'pending' | 'planned' | 'applied' | 'failed' | 'skipped';

export interface IStepRunResult {
  /** Index in the migration's steps array. */
  index: number;
  /** Step id (defaults to `step-<index>`). */
  id: string;
  kind: MigrationStep['kind'];
  status: StepStatus;
  /** Human-readable headline. */
  message: string;
  /** Wall-clock duration of the step, in ms. */
  durationMs: number;
  /** For structural-rewrite steps: counts of files / edits. */
  rewriteStats?: {
    filesScanned: number;
    filesAttempted: number;
    filesChanged: number;
    totalEdits: number;
    conflicts: readonly string[];
  };
  /** For shell / check steps: captured stdout + exit code. */
  shellOutput?: {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  /** Free-form diagnostics from the step. */
  diagnostics: readonly string[];
}

export interface IMigrationRunReport {
  schema: typeof MIGRATION_RUN_SCHEMA;
  migration: { id: string; title: string };
  /** True for the `plan` flow (no fs writes); false for `apply`. */
  dryRun: boolean;
  startedAt: string;
  totalDurationMs: number;
  /** Overall status: `pass` if every step is `applied` (or `skipped`);
   * `fail` if any step failed. */
  overall: 'pass' | 'fail' | 'skipped';
  steps: readonly IStepRunResult[];
}
