import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { MigrationStateStore } from './state-store.ts';
import type { IMigrationRunReport } from '../schema/migration.ts';

export interface IPruneOptions {
  projectRoot: string;
  /** Minimum age in days for a state file to be eligible. Default 30. */
  olderThanDays?: number;
  /**
   * When true, also prune state files where the last recorded run is
   * a `fail`. Default false — failed migrations are typically what the
   * user wants to keep so they can `resume`.
   */
  includeFailed?: boolean;
  /** When true, list what would be deleted but don't touch disk. */
  dryRun?: boolean;
}

export interface IPrunedEntry {
  id: string;
  startedAt: string;
  overall: 'pass' | 'fail' | 'skipped';
  ageDays: number;
  reason: 'older-than' | 'failed-included';
}

export interface IPruneResult {
  schema: 'sharkcraft.migration-prune/v1';
  /** Total state files scanned. */
  scanned: number;
  /** Files matching the eligibility criteria. */
  eligible: number;
  /** Files actually removed (0 in dry-run). */
  removed: number;
  dryRun: boolean;
  entries: readonly IPrunedEntry[];
  diagnostics: readonly string[];
}

/**
 * Prune `.sharkcraft/migrations/*.state.json` files older than
 * `olderThanDays`. Used to keep the dashboard's Migrations panel
 * focused on recent activity.
 *
 * By default skips `overall: 'fail'` entries — those are kept so the
 * user can `shrk migrate resume`. Pass `includeFailed: true` to clear
 * those too (typical after a project-wide cleanup).
 */
export function pruneMigrations(options: IPruneOptions): IPruneResult {
  const olderThanDays = options.olderThanDays ?? 30;
  const includeFailed = options.includeFailed ?? false;
  const dryRun = options.dryRun ?? false;
  const diagnostics: string[] = [];
  const dir = nodePath.join(options.projectRoot, '.sharkcraft', 'migrations');
  if (!existsSync(dir)) {
    return {
      schema: 'sharkcraft.migration-prune/v1',
      scanned: 0,
      eligible: 0,
      removed: 0,
      dryRun,
      entries: [],
      diagnostics: ['no .sharkcraft/migrations/ directory'],
    };
  }
  const store = new MigrationStateStore(options.projectRoot);
  const now = Date.now();
  let scanned = 0;
  const eligibleEntries: IPrunedEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    diagnostics.push(`readdir failed: ${(e as Error).message}`);
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('.state.json')) continue;
    scanned += 1;
    const abs = nodePath.join(dir, entry);
    let report: IMigrationRunReport | undefined;
    try {
      report = store.read(entry.replace(/\.state\.json$/, ''));
    } catch {
      report = undefined;
    }
    let startedAt: string;
    let ageMs: number;
    if (report) {
      startedAt = report.startedAt;
      ageMs = now - Date.parse(report.startedAt);
    } else {
      // Corrupted state file — fall back to mtime.
      try {
        const st = statSync(abs);
        startedAt = new Date(st.mtimeMs).toISOString();
        ageMs = now - st.mtimeMs;
      } catch {
        diagnostics.push(`could not stat ${abs}`);
        continue;
      }
    }
    if (Number.isNaN(ageMs)) continue;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const isFailed = report?.overall === 'fail';
    let reason: 'older-than' | 'failed-included' | undefined;
    if (ageDays >= olderThanDays) {
      if (isFailed && !includeFailed) continue;
      reason = ageDays >= olderThanDays ? 'older-than' : undefined;
      if (isFailed && includeFailed) reason = 'failed-included';
    }
    if (!reason) continue;
    eligibleEntries.push({
      id: report?.migration.id ?? entry.replace(/\.state\.json$/, ''),
      startedAt,
      overall: report?.overall ?? 'skipped',
      ageDays: Math.floor(ageDays * 10) / 10,
      reason,
    });
  }
  let removed = 0;
  if (!dryRun) {
    for (const e of eligibleEntries) {
      try {
        rmSync(nodePath.join(dir, `${e.id}.state.json`));
        removed += 1;
      } catch (err) {
        diagnostics.push(`rm failed for ${e.id}: ${(err as Error).message}`);
      }
    }
  }
  return {
    schema: 'sharkcraft.migration-prune/v1',
    scanned,
    eligible: eligibleEntries.length,
    removed,
    dryRun,
    entries: eligibleEntries,
    diagnostics,
  };
}
