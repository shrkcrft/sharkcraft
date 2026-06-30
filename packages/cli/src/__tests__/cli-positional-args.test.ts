/**
 * Item 6.1 — file-scoped commands must never succeed-with-zero while silently
 * dropping bare positional file args.
 *
 *   - review / diff-check / changes: treat positionals (after any subverb) as
 *     the file list, so a `shrk review src/new.ts` actually reviews that file.
 *   - check: subverbs are flag-driven, so stray positionals are a clear error
 *     (non-zero exit) rather than a confident green over the whole repo.
 *
 * We invoke the handlers directly against a controlled temp git cwd — no
 * subprocess — and assert the positional is honored (or rejected), not dropped.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewCommand } from '../commands/review.command.ts';
import { diffCheckCommand } from '../commands/diff-check.command.ts';
import { changesCommand } from '../commands/changes.command.ts';
import { checkCommand } from '../commands/check.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

function git(cwd: string, ...subargs: string[]): void {
  execSync(`git ${subargs.map((a) => JSON.stringify(a)).join(' ')}`, {
    cwd,
    stdio: 'pipe',
  });
}

function makeArgs(
  cwd: string,
  positional: string[],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  const m = new Map<string, string | boolean>();
  m.set('cwd', cwd);
  for (const [k, v] of Object.entries(flags)) m.set(k, v);
  return { positional, flags: m, multiFlags: new Map(), globalCwd: cwd };
}

async function capture(
  fn: () => Promise<number> | number,
): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown): boolean => {
    outChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown): boolean => {
    errChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out: outChunks.join(''), err: errChunks.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

let WORK: string;
beforeEach(() => {
  WORK = mkdtempSync(join(tmpdir(), 'shrk-positional-'));
  git(WORK, 'init', '-q');
  git(WORK, 'config', 'user.email', 'test@test.test');
  git(WORK, 'config', 'user.name', 'test');
  git(WORK, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(WORK, '.gitignore'), 'node_modules\n');
  git(WORK, 'add', '.gitignore');
  git(WORK, 'commit', '-q', '-m', 'init');
  mkdirSync(join(WORK, 'src'), { recursive: true });
  writeFileSync(join(WORK, 'src/new.ts'), 'export const x = 1;\n');
});
afterEach(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('shrk review — positional file args', () => {
  test('reviews the positional file instead of reporting 0 changed files', async () => {
    const { code, out } = await capture(() =>
      reviewCommand.run(makeArgs(WORK, ['src/new.ts'], { json: true })),
    );
    expect(code).toBe(0);
    const packet = JSON.parse(out) as { changedFiles: string[] };
    expect(packet.changedFiles).toContain('src/new.ts');
    expect(packet.changedFiles.length).toBeGreaterThan(0);
  });
});

describe('shrk diff-check — positional file args', () => {
  test('scopes to the positional file (mode=files) instead of the full worktree', async () => {
    const { code, out } = await capture(() =>
      diffCheckCommand.run(makeArgs(WORK, ['src/new.ts'], { json: true })),
    );
    expect(code).toBe(0);
    const env = JSON.parse(out) as {
      scope: { mode: string; files: string[]; fileCount: number };
    };
    expect(env.scope.mode).toBe('files');
    expect(env.scope.files).toContain('src/new.ts');
    expect(env.scope.fileCount).toBe(1);
  });
});

describe('shrk changes summary — positional file args (after subverb)', () => {
  test('summarizes the positional file instead of dropping it', async () => {
    const { code, out } = await capture(() =>
      changesCommand.run(makeArgs(WORK, ['summary', 'src/new.ts'], { json: true })),
    );
    expect(code).toBe(0);
    const report = JSON.parse(out) as { source: string; totalFiles: number };
    expect(report.source).toBe('files');
    expect(report.totalFiles).toBe(1);
  });
});

describe('shrk check <subverb> — stray positional file args', () => {
  test('errors (non-zero) instead of silently succeeding', async () => {
    const { code, err } = await capture(() =>
      checkCommand.run(makeArgs(WORK, ['boundaries', 'src/new.ts'])),
    );
    expect(code).not.toBe(0);
    expect(err).toContain('Unexpected positional argument');
  });

  test('does not reject the legitimate positionals of `check generation`', async () => {
    // `generation` needs templateId + name; with neither template configured it
    // exits 2 from its own usage/validation path — but NOT from the stray-arg
    // guard, and never with a 0 that silently drops the args.
    const { code, err } = await capture(() =>
      checkCommand.run(makeArgs(WORK, ['generation', 'some-template', 'Widget'])),
    );
    expect(code).not.toBe(0);
    expect(err).not.toContain('Unexpected positional argument');
  });
});
