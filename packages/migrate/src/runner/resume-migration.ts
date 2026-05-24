import { applyMigration, type IApplyMigrationOptions } from './apply-migration.ts';
import { findResumePoint, MigrationStateStore } from './state-store.ts';
import type { IMigration, IMigrationRunReport } from '../schema/migration.ts';

export interface IResumeMigrationOptions {
  projectRoot: string;
  /** Forwarded to applyMigration. */
  dryRun?: boolean;
  stopOnFailure?: boolean;
  shellTimeoutMs?: number;
}

export interface IResumeMigrationResult {
  /** Final run report after the resume. */
  report: IMigrationRunReport;
  /** Step index the resume started at. */
  resumedFromIndex: number;
  /** Free-form diagnostics about the resume decision. */
  diagnostics: readonly string[];
}

/**
 * Pick up a previously-failed migration from the step that failed and
 * continue forward. Reads the saved state at
 * `.sharkcraft/migrations/<id>.state.json` (written by `applyMigration`
 * after each step) and dispatches a fresh `applyMigration` call with
 * `resumeFromIndex` set.
 *
 * Returns a diagnostic and skips re-running when no resume point is
 * found (everything already applied, or no saved state at all).
 */
export function resumeMigration(
  migration: IMigration,
  options: IResumeMigrationOptions,
): IResumeMigrationResult {
  const diagnostics: string[] = [];
  const store = new MigrationStateStore(options.projectRoot);
  const prior = store.read(migration.id);
  if (!prior) {
    diagnostics.push(`no saved state for migration "${migration.id}" — running from the beginning.`);
    const fresh = applyMigration(migration, applyOpts(options));
    return { report: fresh, resumedFromIndex: 0, diagnostics };
  }
  const resumePoint = findResumePoint(prior);
  if (resumePoint === undefined) {
    diagnostics.push(`migration "${migration.id}" already complete; nothing to resume.`);
    return { report: prior, resumedFromIndex: prior.steps.length, diagnostics };
  }
  diagnostics.push(`resuming from step ${resumePoint + 1} (${migration.steps[resumePoint]?.id ?? 'unknown'}).`);
  const report = applyMigration(migration, {
    ...applyOpts(options),
    resumeFromIndex: resumePoint,
    priorSteps: prior.steps.slice(0, resumePoint),
  });
  return { report, resumedFromIndex: resumePoint, diagnostics };
}

function applyOpts(options: IResumeMigrationOptions): IApplyMigrationOptions {
  return {
    projectRoot: options.projectRoot,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.stopOnFailure !== undefined ? { stopOnFailure: options.stopOnFailure } : {}),
    ...(options.shellTimeoutMs !== undefined ? { shellTimeoutMs: options.shellTimeoutMs } : {}),
  };
}
