import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';
import { findResumePoint, type IMigrationRunReport } from '@shrkcrft/migrate';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  /** When set, return only this migration. */
  id?: string;
}

interface IMigrationRow {
  id: string;
  title: string;
  overall: 'pass' | 'fail' | 'skipped';
  dryRun: boolean;
  startedAt: string;
  totalDurationMs: number;
  steps: IMigrationRunReport['steps'];
  resumePoint?: number;
}

interface IMigrationsPayload {
  schema: 'sharkcraft.mcp-migrations/v1';
  available: boolean;
  total: number;
  migrations: readonly IMigrationRow[];
  hint?: string;
}

export const getMigrationsTool: IToolDefinition = {
  name: 'get_migrations',
  description:
    'Read-only: list `@shrkcrft/migrate` run state from `.sharkcraft/migrations/*.state.json`. Mirrors the dashboard Migrations panel. Pass `id` to fetch a single run; otherwise returns every saved state newest-first.',
  cliCommand: 'migrate',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    const projectRoot = ctx.inspection.projectRoot;
    const dir = nodePath.join(projectRoot, '.sharkcraft', 'migrations');
    if (!existsSync(dir)) {
      const payload: IMigrationsPayload = {
        schema: 'sharkcraft.mcp-migrations/v1',
        available: false,
        total: 0,
        migrations: [],
        hint: 'no migrations have been run yet',
      };
      return { data: payload };
    }
    const rows: IMigrationRow[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      /* ignore */
    }
    for (const entry of entries) {
      if (!entry.endsWith('.state.json')) continue;
      const abs = nodePath.join(dir, entry);
      try {
        const report = JSON.parse(readFileSync(abs, 'utf8')) as IMigrationRunReport;
        if (args.id && report.migration.id !== args.id) continue;
        const resumePoint = findResumePoint(report);
        rows.push({
          id: report.migration.id,
          title: report.migration.title,
          overall: report.overall,
          dryRun: report.dryRun,
          startedAt: report.startedAt,
          totalDurationMs: report.totalDurationMs,
          steps: report.steps,
          ...(resumePoint !== undefined ? { resumePoint } : {}),
        });
      } catch {
        /* skip corrupt state */
      }
    }
    rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const payload: IMigrationsPayload = {
      schema: 'sharkcraft.mcp-migrations/v1',
      available: true,
      total: rows.length,
      migrations: rows,
    };
    return { data: payload };
  },
};
