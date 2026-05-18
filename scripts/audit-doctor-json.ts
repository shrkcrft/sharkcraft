#!/usr/bin/env bun
/**
 * R58 PART 4 — Doctor-verb --json consistency audit.
 *
 * Walks `COMMAND_CATALOG` for entries whose command ends in `doctor`
 * (excluding flagged or positional variants), spawns
 * `shrk <verb> --json`, and asserts each emits parseable JSON on
 * stdout. Exits non-zero on any new failure so `release:preflight`
 * gates regressions.
 *
 * Schema: `sharkcraft.doctor-json-audit/v1`
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as nodePath from 'node:path';
import { COMMAND_CATALOG } from '../packages/cli/src/commands/command-catalog.ts';

const CLI_MAIN = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'cli',
  'src',
  'main.ts',
);

interface IAuditEntry {
  verb: string;
  ok: boolean;
  reason?: string;
  exitCode?: number;
  firstBytes?: string;
}

interface IAuditReport {
  schema: 'sharkcraft.doctor-json-audit/v1';
  total: number;
  passed: number;
  failed: number;
  entries: IAuditEntry[];
}

function listDoctorVerbs(): string[] {
  const verbs = new Set<string>();
  for (const entry of COMMAND_CATALOG) {
    const cmd = entry.command;
    // Skip flagged or positional variants — we only audit the bare verb.
    if (cmd.includes('--') || cmd.includes('<') || cmd.includes('|')) continue;
    if (cmd === 'doctor' || cmd.endsWith(' doctor')) verbs.add(cmd);
  }
  return [...verbs].sort();
}

function runVerb(verb: string): IAuditEntry {
  const parts = verb.split(/\s+/);
  const result = spawnSync('bun', ['run', CLI_MAIN, ...parts, '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const stdout = (result.stdout ?? '').toString();
  const first = stdout.trimStart()[0];
  if (first !== '{' && first !== '[') {
    return {
      verb,
      ok: false,
      reason: 'stdout did not start with JSON',
      exitCode: result.status ?? undefined,
      firstBytes: stdout.slice(0, 120).replace(/\s+/g, ' '),
    };
  }
  try {
    JSON.parse(stdout);
  } catch (e) {
    return {
      verb,
      ok: false,
      reason: `JSON parse failed: ${(e as Error).message}`,
      exitCode: result.status ?? undefined,
      firstBytes: stdout.slice(0, 120).replace(/\s+/g, ' '),
    };
  }
  return { verb, ok: true, exitCode: result.status ?? undefined };
}

export function runDoctorJsonAudit(): IAuditReport {
  const verbs = listDoctorVerbs();
  const entries = verbs.map(runVerb);
  return {
    schema: 'sharkcraft.doctor-json-audit/v1',
    total: entries.length,
    passed: entries.filter((e) => e.ok).length,
    failed: entries.filter((e) => !e.ok).length,
    entries,
  };
}

function main(): number {
  const report = runDoctorJsonAudit();
  const wantJson = process.argv.includes('--json');
  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`=== Doctor --json audit ===\n`);
    process.stdout.write(`  total:    ${report.total}\n`);
    process.stdout.write(`  passed:   ${report.passed}\n`);
    process.stdout.write(`  failed:   ${report.failed}\n\n`);
    for (const e of report.entries) {
      if (e.ok) {
        process.stdout.write(`  ✓ ${e.verb}\n`);
      } else {
        process.stdout.write(`  ✗ ${e.verb} — ${e.reason ?? '?'}\n`);
        if (e.firstBytes) {
          process.stdout.write(`      first bytes: ${e.firstBytes}\n`);
        }
      }
    }
    if (report.failed > 0) {
      process.stdout.write(
        `\nFix: every doctor verb must emit parseable JSON when --json is passed,\n` +
          `including the error/validation paths. See packages/cli/src/commands/reposet.command.ts\n` +
          `for the standard pattern (JSON envelope on stdout, never text on stderr when --json).\n`,
      );
    }
  }
  return report.failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
