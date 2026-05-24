import { spawnSync } from 'node:child_process';
import * as nodePath from 'node:path';
import { applyRewritePlan, planRewrite } from '@shrkcrft/structural-search';
import {
  MIGRATION_RUN_SCHEMA,
  type IMigration,
  type IMigrationRunReport,
  type IStepRunResult,
} from '../schema/migration.ts';
import { MigrationStateStore } from './state-store.ts';

export interface IApplyMigrationOptions {
  projectRoot: string;
  /** When true, structural rewrites compute but don't write. Shell and
   * check steps are still skipped (not executed). Default false. */
  dryRun?: boolean;
  /** When true, the runner stops at the first failed step. Default true. */
  stopOnFailure?: boolean;
  /** Per-shell timeout in ms. Default 5 * 60 * 1000. */
  shellTimeoutMs?: number;
  /**
   * When true, persist a checkpoint after each step (and the final
   * report) to `.sharkcraft/migrations/<id>.state.json` so
   * `resumeMigration` can pick up where `apply` left off. Default true
   * for non-dry-run, false for dry-run.
   */
  persistCheckpoints?: boolean;
  /**
   * Index of the step to start at. Steps before this index are
   * carried over from `priorSteps` with status `applied`. Used by
   * `resumeMigration`; callers don't typically set this directly.
   */
  resumeFromIndex?: number;
  /** Step results carried over from a prior run (when resuming). */
  priorSteps?: readonly IStepRunResult[];
}

/**
 * Execute a migration end-to-end. Returns a structured run report;
 * never throws (errors are captured in per-step `status: 'failed'`).
 *
 * `structural-rewrite` steps go through `planRewrite` + `applyRewritePlan`
 * (or stop at plan when `dryRun: true`). `shell` / `check` steps run
 * via `spawnSync(bash -c, ...)`. A `check` step that exits non-zero
 * marks the step as `failed` and (by default) halts the run.
 */
export function applyMigration(
  migration: IMigration,
  options: IApplyMigrationOptions,
): IMigrationRunReport {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const dryRun = options.dryRun ?? false;
  const stopOnFailure = options.stopOnFailure ?? true;
  const shellTimeoutMs = options.shellTimeoutMs ?? 5 * 60 * 1000;
  const persist = options.persistCheckpoints ?? !dryRun;
  const resumeFromIndex = options.resumeFromIndex ?? 0;
  const priorSteps = options.priorSteps ?? [];
  const store = persist ? new MigrationStateStore(options.projectRoot) : undefined;
  const results: IStepRunResult[] = [];
  let halted = false;

  // Carry forward prior successful steps when resuming.
  if (resumeFromIndex > 0 && priorSteps.length > 0) {
    for (const p of priorSteps) {
      if (p.index >= resumeFromIndex) break;
      // Re-stamp status as `applied` (in case the prior run halted
      // BEFORE this step's status was updated — shouldn't happen with
      // checkpoints but be defensive).
      results.push(p.status === 'applied' || p.status === 'planned' || p.status === 'skipped'
        ? p
        : { ...p, status: 'applied' });
    }
  }

  for (let i = resumeFromIndex; i < migration.steps.length; i += 1) {
    const step = migration.steps[i]!;
    const id = step.id ?? `step-${i + 1}`;
    if (halted) {
      results.push({
        index: i,
        id,
        kind: step.kind,
        status: 'skipped',
        message: 'skipped after previous failure',
        durationMs: 0,
        diagnostics: [],
      });
      continue;
    }
    const stepStart = Date.now();
    if (step.kind === 'structural-rewrite') {
      const plan = planRewrite({
        projectRoot: options.projectRoot,
        pattern: step.pattern,
        recipe: step.recipe,
      });
      const apply = applyRewritePlan(plan, { projectRoot: options.projectRoot, dryRun });
      const failed = apply.conflicts.length > 0;
      results.push({
        index: i,
        id,
        kind: step.kind,
        status: failed ? 'failed' : (dryRun ? 'planned' : 'applied'),
        message: failed
          ? `${apply.conflicts.length} conflict(s) — file content drifted`
          : `${apply.filesChanged} file(s) ${dryRun ? 'would be ' : ''}changed, ${plan.totalEdits} edit(s)`,
        durationMs: Date.now() - stepStart,
        rewriteStats: {
          filesScanned: plan.filesScanned,
          filesAttempted: apply.filesAttempted,
          filesChanged: apply.filesChanged,
          totalEdits: plan.totalEdits,
          conflicts: apply.conflicts,
        },
        diagnostics: [...plan.diagnostics, ...apply.diagnostics],
      });
      if (failed && stopOnFailure) halted = true;
    } else if (step.kind === 'shell' || step.kind === 'check') {
      if (dryRun) {
        results.push({
          index: i,
          id,
          kind: step.kind,
          status: 'planned',
          message: `${step.kind} (dry-run): ${step.command}`,
          durationMs: Date.now() - stepStart,
          diagnostics: [],
        });
        continue;
      }
      const cwd = step.cwd
        ? nodePath.resolve(options.projectRoot, step.cwd)
        : options.projectRoot;
      const res = spawnSync('bash', ['-c', step.command], {
        cwd,
        encoding: 'utf8',
        timeout: shellTimeoutMs,
      });
      const exitCode = res.status ?? -1;
      const failed = exitCode !== 0;
      results.push({
        index: i,
        id,
        kind: step.kind,
        status: failed ? 'failed' : 'applied',
        message: failed
          ? `exit ${exitCode}: ${oneLine(res.stderr ?? '') || step.command}`
          : `exit 0: ${step.command}`,
        durationMs: Date.now() - stepStart,
        shellOutput: {
          exitCode,
          stdout: (res.stdout ?? '').slice(0, 8000),
          stderr: (res.stderr ?? '').slice(0, 8000),
        },
        diagnostics: [],
      });
      if (step.kind === 'check' && failed && stopOnFailure) halted = true;
    }
    if (store) {
      // Per-step checkpoint so a crashing runner / killed process can
      // still be resumed from the right point.
      store.write(migration.id, buildPartialReport(migration, dryRun, startedAt, start, results));
    }
  }
  const overall: 'pass' | 'fail' | 'skipped' =
    results.some((r) => r.status === 'failed')
      ? 'fail'
      : results.some((r) => r.status === 'applied' || r.status === 'planned')
        ? 'pass'
        : 'skipped';
  const report: IMigrationRunReport = {
    schema: MIGRATION_RUN_SCHEMA,
    migration: { id: migration.id, title: migration.title },
    dryRun,
    startedAt,
    totalDurationMs: Date.now() - start,
    overall,
    steps: results,
  };
  if (store) store.write(migration.id, report);
  return report;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function buildPartialReport(
  migration: IMigration,
  dryRun: boolean,
  startedAt: string,
  start: number,
  results: readonly IStepRunResult[],
): IMigrationRunReport {
  const overall: 'pass' | 'fail' | 'skipped' =
    results.some((r) => r.status === 'failed')
      ? 'fail'
      : results.some((r) => r.status === 'applied' || r.status === 'planned')
        ? 'pass'
        : 'skipped';
  return {
    schema: MIGRATION_RUN_SCHEMA,
    migration: { id: migration.id, title: migration.title },
    dryRun,
    startedAt,
    totalDurationMs: Date.now() - start,
    overall,
    steps: results,
  };
}
