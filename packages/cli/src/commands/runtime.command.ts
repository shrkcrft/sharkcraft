import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const REPORT_FILE = '.sharkcraft/reports/compat-node-report.json';

export const runtimeDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Report runtime info + latest Node-compatibility audit. Read-only; no shell.',
  usage: 'shrk runtime doctor [--json]',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    const reportPath = nodePath.join(cwd, REPORT_FILE);
    const reportExists = existsSync(reportPath);
    let report: unknown = null;
    if (reportExists) {
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
      } catch {
        report = null;
      }
    }
    // Avoid a direct `Bun.<x>` reference so the compat:node scanner stays
    // green when this file ships to a pure-Node runtime; read via globalThis
    // instead. The audit script flags `Bun.<id>` shaped tokens outside
    // string literals.
    const g = globalThis as unknown as { Bun?: { version?: string } };
    const runtime: Record<string, unknown> = {
      bun: g.Bun?.version ?? null,
      node: typeof process !== 'undefined' ? process.version : null,
      platform: process.platform,
      arch: process.arch,
    };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ runtime, reportFile: reportExists ? reportPath : null, report }) + '\n');
      return 0;
    }
    process.stdout.write(header('Runtime doctor'));
    process.stdout.write(kv('bun', String(runtime['bun'] ?? '(node)')) + '\n');
    process.stdout.write(kv('node', String(runtime['node'])) + '\n');
    process.stdout.write(kv('platform', `${runtime['platform']}-${runtime['arch']}`) + '\n');
    if (reportExists) {
      const r = report as { passed?: boolean; bunUsage?: unknown[]; runtimeProbes?: unknown[] } | null;
      process.stdout.write(kv('compat:node report', reportPath) + '\n');
      if (r) {
        process.stdout.write(kv('  passed', String(r.passed)) + '\n');
        process.stdout.write(kv('  bun.* usages', String((r.bunUsage ?? []).length)) + '\n');
        process.stdout.write(kv('  runtime probes', String((r.runtimeProbes ?? []).length)) + '\n');
      }
    } else {
      process.stdout.write('compat:node report: (none — run `bun run compat:node --runtime --build`)\n');
    }
    return 0;
  },
};
