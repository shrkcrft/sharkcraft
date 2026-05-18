/**
 * Doctor-verb --json consistency.
 *
 *   - the audit module enumerates every doctor verb in the catalog
 *   - reposet doctor emits a JSON envelope (not stderr text) when
 *     `--json` is set and the workspace lacks a reposet config
 *   - the audit currently reports 0 failures for the shipped catalog
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as nodePath from 'node:path';
import { runDoctorJsonAudit } from '../../../../scripts/audit-doctor-json.ts';
import { reposetDoctorCommand } from '../commands/reposet.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const TMP_BASE = nodePath.join('/tmp', 'r58-doctor-json');
let projectRoot: string;
let captured: { stdout: string; stderr: string };
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;

function capture(): void {
  captured = { stdout: '', stderr: '' };
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  const outOverride = (chunk: string | Uint8Array): boolean => {
    captured.stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  const errOverride = (chunk: string | Uint8Array): boolean => {
    captured.stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  process.stdout.write = outOverride as typeof process.stdout.write;
  process.stderr.write = errOverride as typeof process.stderr.write;
}

function restore(): void {
  if (origStdout) process.stdout.write = origStdout;
  if (origStderr) process.stderr.write = origStderr;
}

function makeArgs(flags: Record<string, string | boolean> = {}): ParsedArgs {
  const m = new Map<string, string | boolean>();
  for (const [k, v] of Object.entries(flags)) m.set(k, v);
  return {
    positional: [],
    flags: m,
    multiFlags: new Map(),
    globalCwd: projectRoot,
  };
}

beforeEach(() => {
  projectRoot = nodePath.join(
    TMP_BASE,
    `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  restore();
  if (projectRoot && existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('doctor-verb --json audit', () => {
  test('reposet doctor emits a JSON envelope on missing config when --json is set', async () => {
    capture();
    const rc = await reposetDoctorCommand.run(makeArgs({ json: true }));
    restore();
    expect(rc).toBe(1);
    expect(captured.stderr).toBe('');
    const payload = JSON.parse(captured.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('reposet-config-missing');
    expect(typeof payload.hint).toBe('string');
  });

  test('reposet doctor still writes stderr text on missing config without --json', async () => {
    capture();
    const rc = await reposetDoctorCommand.run(makeArgs());
    restore();
    expect(rc).toBe(1);
    expect(captured.stderr).toContain('No reposet config');
    expect(captured.stdout).toBe('');
  });

  test(
    'audit module runs against the current catalog with 0 failures',
    () => {
      const report = runDoctorJsonAudit();
      expect(report.schema).toBe('sharkcraft.doctor-json-audit/v1');
      expect(report.total).toBeGreaterThan(0);
      if (report.failed > 0) {
        const failedSummary = report.entries
          .filter((e) => !e.ok)
          .map((e) => `${e.verb}: ${e.reason}`)
          .join('\n  ');
        throw new Error(
          `Doctor --json audit found ${report.failed} regression(s):\n  ${failedSummary}`,
        );
      }
      expect(report.failed).toBe(0);
    },
    // Each verb spawns a fresh `bun run` cold start; 8 verbs × ~700ms
    // can easily exceed the 5s default on CI runners.
    30_000,
  );
});
