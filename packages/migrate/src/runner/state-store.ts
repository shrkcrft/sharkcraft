import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IMigrationRunReport } from '../schema/migration.ts';

const DIR = '.sharkcraft/migrations';

/**
 * Persist per-migration run state under `.sharkcraft/migrations/`. The
 * checkpoint is the full `IMigrationRunReport` so far — `resumeMigration`
 * reads it back, finds the last failed step, and continues from there.
 */
export class MigrationStateStore {
  public readonly dir: string;

  constructor(private readonly projectRoot: string) {
    this.dir = nodePath.join(projectRoot, DIR);
  }

  pathFor(migrationId: string): string {
    return nodePath.join(this.dir, `${migrationId}.state.json`);
  }

  exists(migrationId: string): boolean {
    return existsSync(this.pathFor(migrationId));
  }

  read(migrationId: string): IMigrationRunReport | undefined {
    if (!this.exists(migrationId)) return undefined;
    try {
      return JSON.parse(readFileSync(this.pathFor(migrationId), 'utf8')) as IMigrationRunReport;
    } catch {
      return undefined;
    }
  }

  write(migrationId: string, report: IMigrationRunReport): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(migrationId), JSON.stringify(report, null, 2), 'utf8');
  }

  clear(migrationId: string): void {
    if (this.exists(migrationId)) rmSync(this.pathFor(migrationId));
  }
}

/**
 * Find the index of the first step the resume runner should re-execute.
 *
 *   - First failed step → resume from there.
 *   - No failures + steps remaining → resume from the first skipped /
 *     pending step.
 *   - All steps applied → undefined (nothing to resume).
 */
export function findResumePoint(report: IMigrationRunReport): number | undefined {
  for (const s of report.steps) {
    if (s.status === 'failed') return s.index;
  }
  for (const s of report.steps) {
    if (s.status === 'skipped' || s.status === 'pending') return s.index;
  }
  return undefined;
}
