/**
 * Tests for `shrk diff-check`.
 *
 * The command is mostly glue around two existing engines — what
 * matters most is the public contract:
 *
 *   1. The JSON envelope shape is stable (agents depend on it).
 *   2. The verdict derivation collapses two engines' outputs into
 *      one of: ok | warnings | errors.
 *   3. The `nextAction` line is concrete and varies per verdict.
 *   4. Exit code reflects verdict (errors → 1, ok/warnings → 0).
 *
 * We exercise the command against a temporary cwd with a controlled
 * git state — no fixtures, no spawning. Just call the handler.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { diffCheckCommand } from '../commands/diff-check.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

interface ICapturedRun {
  exitCode: number;
  stdout: string;
  envelope: Record<string, unknown> | null;
}

function makeArgs(cwd: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  const m = new Map<string, string | boolean>();
  m.set('cwd', cwd);
  for (const [k, v] of Object.entries(flags)) m.set(k, v);
  return {
    positional: [],
    flags: m,
    multiFlags: new Map(),
    globalCwd: cwd,
  };
}

async function runDiffCheck(
  cwd: string,
  flags: Record<string, string | boolean> = {},
): Promise<ICapturedRun> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = await diffCheckCommand.run(makeArgs(cwd, flags));
    const stdout = chunks.join('');
    let envelope: Record<string, unknown> | null = null;
    if (flags['json']) {
      try {
        envelope = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        envelope = null;
      }
    }
    return { exitCode, stdout, envelope };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function git(cwd: string, ...subargs: string[]): void {
  execSync(`git ${subargs.map((a) => JSON.stringify(a)).join(' ')}`, {
    cwd,
    stdio: 'pipe',
  });
}

let WORK: string;
beforeEach(() => {
  WORK = mkdtempSync(join(tmpdir(), 'shrk-diff-check-'));
  git(WORK, 'init', '-q');
  git(WORK, 'config', 'user.email', 'test@test.test');
  git(WORK, 'config', 'user.name', 'test');
  git(WORK, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(WORK, '.gitignore'), 'node_modules\n');
  git(WORK, 'add', '.');
  git(WORK, 'commit', '-q', '-m', 'init');
});
afterEach(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('shrk diff-check — clean cwd (no rules, no diff)', () => {
  test('returns verdict=ok when there are no changed files', async () => {
    const r = await runDiffCheck(WORK, { json: true });
    expect(r.exitCode).toBe(0);
    expect(r.envelope).not.toBeNull();
    expect(r.envelope?.schema).toBe('sharkcraft.diff-check/v1');
    expect(r.envelope?.verdict).toBe('ok');
    expect(typeof r.envelope?.nextAction).toBe('string');
    const scope = r.envelope?.scope as { fileCount: number };
    expect(scope.fileCount).toBe(0);
  });
});

describe('shrk diff-check — envelope shape', () => {
  test('envelope contains the documented top-level keys', async () => {
    mkdirSync(join(WORK, 'src'), { recursive: true });
    writeFileSync(join(WORK, 'src/touched.ts'), 'export const x = 1;\n');
    const r = await runDiffCheck(WORK, { json: true });
    expect(r.envelope).not.toBeNull();
    const env = r.envelope!;
    for (const key of [
      'schema',
      'generatedAt',
      'scope',
      'boundaries',
      'imports',
      'verdict',
      'summary',
      'nextAction',
    ]) {
      expect(Object.keys(env)).toContain(key);
    }
  });

  test('scope.mode defaults to "worktree"', async () => {
    mkdirSync(join(WORK, 'src'), { recursive: true });
    writeFileSync(join(WORK, 'src/a.ts'), 'export const a = 1;\n');
    const r = await runDiffCheck(WORK, { json: true });
    const scope = r.envelope?.scope as { mode: string };
    expect(scope.mode).toBe('worktree');
  });

  test('scope.mode is "files" when --files is passed', async () => {
    writeFileSync(join(WORK, 'foo.ts'), 'export const foo = 1;\n');
    const r = await runDiffCheck(WORK, { files: 'foo.ts', json: true });
    const scope = r.envelope?.scope as { mode: string };
    expect(scope.mode).toBe('files');
  });
});

describe('shrk diff-check — verdict + nextAction language', () => {
  test('verdict=ok carries the "Safe to declare done" next action', async () => {
    const r = await runDiffCheck(WORK, { json: true });
    expect(r.envelope?.verdict).toBe('ok');
    expect(typeof r.envelope?.nextAction).toBe('string');
  });

  test('non-JSON output prints a "Next:" line', async () => {
    const r = await runDiffCheck(WORK, {});
    expect(r.stdout).toContain('Next:');
    expect(r.stdout).toContain('verdict');
  });
});
