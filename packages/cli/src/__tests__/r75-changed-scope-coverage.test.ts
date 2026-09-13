/**
 * Round 11 (closing#d) — finish / diff-check / `check boundaries --changed-only`
 * report a verified pass only over something a rule actually governs, and never
 * over a rule-only edit.
 *
 * Reproduced before: adding a file no boundary rule governs read `boundaries
 * pass (0 errors)`; tightening a rule with no source change read "No boundary
 * violations introduced", "Safe to finish" and "Diff passes the gate", exit 0,
 * while a full run failed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkCommand } from '../commands/check.command.ts';
import { diffCheckCommand } from '../commands/diff-check.command.ts';
import { finishCommand } from '../commands/finish.command.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = orig;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(root: string, ...a: string[]): void {
  spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], { cwd: root });
}

const RULES = (forbidden: string): string =>
  `export default [{ id: 'app.fence', title: 'App fence', severity: 'error', from: ['src/app/**'], forbiddenImports: [${forbidden}] }];\n`;

/** A committed repo: one rule governing src/app/**, plus ungoverned lib/ files. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-scope-'));
  roots.push(root);
  const files: Record<string, string> = {
    '.gitignore': '.sharkcraft/\n',
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts': RULES("'@scope/ui'"),
    'src/app/a.ts': "import { d } from '@scope/data';\nexport const a = d;\n",
    'lib/free.ts': 'export const free = 1;\n',
    'lib/free.js': 'module.exports = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const gate = (report: { gates: { name: string; status: string; detail: string }[] }, name: string) =>
  report.gates.find((g) => g.name === name);

describe('a change no boundary rule governs is not a boundaries pass', () => {
  test('an ungoverned non-TS change: every deciding gate skips, finish is NOT verified (2)', async () => {
    const root = repo();
    writeFileSync(join(root, 'lib', 'free.js'), 'module.exports = 2;\n');
    const r = await run(finishCommand, args(root, [], { since: 'HEAD', json: true }));
    const report = JSON.parse(r.out);
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(report.verdict).toBe('not-verified');
    expect(gate(report, 'boundaries')?.status).toBe('skipped');
    expect(gate(report, 'boundaries')?.detail).toContain('no changed source file is governed');
    expect(report.gate.exit).toBe(r.code);
  });

  test('an ungoverned .ts change: the boundaries gate SKIPS — it never reports pass over files no rule governs', async () => {
    const root = repo();
    writeFileSync(join(root, 'lib', 'free.ts'), 'export const free = 2;\n');
    const report = JSON.parse((await run(finishCommand, args(root, [], { since: 'HEAD', json: true }))).out);
    expect(gate(report, 'boundaries')?.status).toBe('skipped');
    // Import hygiene genuinely read the file, so the composite rests on it alone.
    expect(gate(report, 'imports')?.status).toBe('pass');
  });

  test('check boundaries --changed-only over an ungoverned change is an empty selection: 2, and --allow-empty accepts it', async () => {
    const root = repo();
    writeFileSync(join(root, 'lib', 'free.ts'), 'export const free = 3;\n');
    const bare = await run(checkCommand, args(root, ['boundaries'], { 'changed-only': true }));
    expect(bare.code).toBe(ExitCode.NotVerified);
    expect(bare.out).toContain('no changed source file is governed');
    expect(bare.out).toContain('--allow-empty');
    const accepted = await run(checkCommand, args(root, ['boundaries'], { 'changed-only': true, 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('accepted by --allow-empty');
  });
});

describe('a rule-only edit that introduces a violation in an unchanged file fails everywhere', () => {
  function tightened(): string {
    const root = repo();
    writeFileSync(join(root, 'sharkcraft', 'boundaries.ts'), RULES("'@scope/ui', '@scope/data'"));
    return root;
  }

  test('check boundaries --changed-only exits 1 and prints the escalation', async () => {
    const r = await run(checkCommand, args(tightened(), ['boundaries'], { 'changed-only': true }));
    expect(r.code).toBe(ExitCode.Failure);
    expect(r.out).toContain('escalated');
    expect(r.out).toContain('src/app/a.ts:1');
  });

  test('finish exits 1', async () => {
    const r = await run(finishCommand, args(tightened(), [], { since: 'HEAD', json: true }));
    expect(r.code).toBe(ExitCode.Failure);
    expect(gate(JSON.parse(r.out), 'boundaries')?.status).toBe('fail');
  });

  test('diff-check exits 1', async () => {
    const r = await run(diffCheckCommand, args(tightened(), [], { since: 'HEAD', json: true }));
    const env = JSON.parse(r.out);
    expect(r.code).toBe(ExitCode.Failure);
    expect(env.verdict).toBe('errors');
    expect(env.boundaries.escalation.ruleIds).toEqual(['app.fence']);
  });
});

describe('an earned green is still possible, and "nowhere" is not a pass', () => {
  test('positive control: a governed code change with no violation → finish 0', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'app', 'a.ts'), "import { d } from '@scope/data';\nexport const a = d + 1;\n");
    const r = await run(finishCommand, args(root, [], { since: 'HEAD', json: true }));
    const report = JSON.parse(r.out);
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(gate(report, 'boundaries')?.status).toBe('pass');
  });

  test('diff-check outside a git repo exits 2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-nogit-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
    const r = await run(diffCheckCommand, args(root, [], { json: true }));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(JSON.parse(r.out).verdict).toBe('not-verified');
  });
});
