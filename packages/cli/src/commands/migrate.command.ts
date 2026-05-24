import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { safeImport } from '@shrkcrft/core';
import {
  applyMigration,
  planMigration,
  pruneMigrations,
  resumeMigration,
  type IMigration,
} from '@shrkcrft/migrate';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * `shrk migrate` — run a multi-step migration definition.
 *
 *   - shrk migrate plan <id>      preview what each step would do
 *   - shrk migrate apply <id>     execute the migration (writes!)
 *
 * Migrations live in `sharkcraft/migrations/<id>.ts` by default; pass
 * `--from <path>` to point at a specific file. Each migration file
 * default-exports an `IMigration` (use `defineMigration({ ... })`).
 */
export const migrateCommand: ICommandHandler = {
  name: 'migrate',
  description:
    'Orchestrate multi-step refactors: structural rewrites + shell + checks in one named, replayable migration.',
  usage:
    'shrk migrate plan <id> [--from <path>] [--json] | shrk migrate apply <id> [--from <path>] [--dry-run] [--no-stop-on-failure] [--json] | shrk migrate resume <id> [--from <path>] [--json] | shrk migrate prune [--older-than <days>] [--include-failed] [--dry-run] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub !== 'plan' && sub !== 'apply' && sub !== 'resume' && sub !== 'prune') {
      process.stderr.write(this.usage + '\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    if (sub === 'prune') {
      const olderThanRaw = flagString(args, 'older-than');
      const olderThanDays = olderThanRaw !== undefined ? Number(olderThanRaw) : undefined;
      if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
        process.stderr.write(`Invalid --older-than: ${olderThanRaw}\n`);
        return 2;
      }
      const result = pruneMigrations({
        projectRoot: cwd,
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
        includeFailed: flagBool(args, 'include-failed'),
        dryRun: flagBool(args, 'dry-run'),
      });
      if (wantJson) {
        process.stdout.write(asJson(result) + '\n');
        return 0;
      }
      process.stdout.write(header(`Migrate prune (${result.dryRun ? 'dry-run' : 'applied'})`));
      process.stdout.write(kv('scanned', String(result.scanned)) + '\n');
      process.stdout.write(kv('eligible', String(result.eligible)) + '\n');
      process.stdout.write(kv('removed', String(result.removed)) + '\n');
      for (const e of result.entries.slice(0, 50)) {
        process.stdout.write(`  ${e.id}  (${e.overall}, ${e.ageDays}d, reason=${e.reason})\n`);
      }
      return 0;
    }
    const id = args.positional[1];
    if (!id) {
      process.stderr.write('Usage: shrk migrate ' + sub + ' <id>\n');
      return 2;
    }
    const fromFlag = flagString(args, 'from');
    const candidate = fromFlag
      ? (nodePath.isAbsolute(fromFlag) ? fromFlag : nodePath.resolve(cwd, fromFlag))
      : nodePath.resolve(cwd, 'sharkcraft', 'migrations', `${id}.ts`);
    if (!existsSync(candidate)) {
      process.stderr.write(`Migration file not found: ${candidate}\n`);
      return 1;
    }
    const result = await safeImport<{ default?: IMigration; migration?: IMigration }>(candidate);
    if (!result.ok) {
      process.stderr.write(`Migration load failed: ${result.error.message}\n`);
      return 1;
    }
    const migration = result.module.default ?? result.module.migration;
    if (!migration) {
      process.stderr.write(`Migration module ${candidate} does not export a default migration.\n`);
      return 1;
    }
    if (migration.id !== id) {
      process.stderr.write(`Migration id mismatch: requested "${id}", file contains "${migration.id}".\n`);
      return 1;
    }

    if (sub === 'plan') {
      const plan = planMigration(migration, cwd);
      if (wantJson) {
        process.stdout.write(asJson(plan) + '\n');
        return 0;
      }
      process.stdout.write(header(`Migration plan: ${plan.migration.title}`));
      process.stdout.write(kv('id', plan.migration.id) + '\n');
      process.stdout.write(kv('total steps', String(plan.plannedSteps.length)) + '\n');
      process.stdout.write(kv('total edits', String(plan.totalEdits)) + '\n');
      process.stdout.write(kv('files affected', String(plan.totalFiles)) + '\n');
      for (const step of plan.plannedSteps) {
        process.stdout.write(`\n  [${step.index + 1}/${plan.plannedSteps.length}] ${step.id} (${step.step.kind})\n`);
        if (step.description) process.stdout.write(`     ${step.description}\n`);
        if (step.rewritePlan) {
          process.stdout.write(`     files=${step.rewritePlan.files.length}  edits=${step.rewritePlan.totalEdits}\n`);
        } else if (step.step.kind === 'shell' || step.step.kind === 'check') {
          process.stdout.write(`     $ ${step.step.command}\n`);
        }
      }
      return 0;
    }

    // apply / resume
    const dryRun = flagBool(args, 'dry-run');
    const noStop = flagBool(args, 'no-stop-on-failure');
    let report;
    let resumedFromIndex = 0;
    const resumeDiagnostics: string[] = [];
    if (sub === 'resume') {
      const result = resumeMigration(migration, {
        projectRoot: cwd,
        dryRun,
        stopOnFailure: !noStop,
      });
      report = result.report;
      resumedFromIndex = result.resumedFromIndex;
      for (const d of result.diagnostics) resumeDiagnostics.push(d);
    } else {
      report = applyMigration(migration, {
        projectRoot: cwd,
        dryRun,
        stopOnFailure: !noStop,
      });
    }
    if (wantJson) {
      process.stdout.write(asJson({ ...report, resumedFromIndex, resumeDiagnostics }) + '\n');
      return report.overall === 'fail' ? 1 : 0;
    }
    if (sub === 'resume') {
      for (const d of resumeDiagnostics) process.stdout.write(`! ${d}\n`);
    }
    process.stdout.write(header(`Migration ${dryRun ? '(dry-run)' : '(applied)'}: ${report.overall.toUpperCase()}`));
    process.stdout.write(kv('id', report.migration.id) + '\n');
    process.stdout.write(kv('total duration', `${report.totalDurationMs}ms`) + '\n');
    for (const s of report.steps) {
      process.stdout.write(`  [${s.status.padEnd(8)}] ${s.id} (${s.kind})  (${s.durationMs}ms)\n`);
      process.stdout.write(`              ${s.message}\n`);
      if (s.rewriteStats && s.rewriteStats.conflicts.length > 0) {
        for (const c of s.rewriteStats.conflicts.slice(0, 5)) {
          process.stdout.write(`                conflict: ${c}\n`);
        }
      }
    }
    return report.overall === 'fail' ? 1 : 0;
  },
};
