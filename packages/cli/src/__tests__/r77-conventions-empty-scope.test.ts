/**
 * r77 — `conventions check` is a verdict verb (round 13, lane P; facts-V3).
 *
 * Over an empty scope (not a git repository, no conventions) it printed
 * `=== Convention check (0 files, 0 hits) === ok — no violations.` at exit 0
 * and `{"filesScanned":0,"hits":[],"verdict":"clean"}` — "nothing to examine"
 * read as a pass. Now it settles through the shared gate envelope: 2 NOT
 * VERIFIED over an empty file scope, no convention declared, or a convention
 * file that never loaded; `--allow-empty` accepts the first two explicitly
 * (printed), never the third; an error-severity hit is 1.
 *
 * Real workspaces, the CLI spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { conventionsCheckCommand } from '../commands/conventions.command.ts';
import { ExitCode, isGateVerb, usageExitFor } from '../exit-codes.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NAMING =
  "export default [\n  { id: 'c.names', title: 'Names', kind: 'naming', severity: 'error', rules: [{ id: 'no-bad', description: 'no file named bad', forbidMatch: 'bad' }] },\n];\n";

function workspace(config = '', files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-conventions-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx'${config ? `, ${config}` : ''} };\n`,
    'src/good.ts': 'export const good = 1;\n',
    'src/bad.ts': 'export const bad = 1;\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', 'conventions', 'check', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface ICheckJson {
  readonly schema: string;
  readonly filesScanned: number;
  readonly verdict: string;
  readonly exitCode: number;
  readonly gate: { exit: number; verdict: string; shortfalls: readonly string[]; accepted: readonly string[] };
}

function json(cwd: string, argv: readonly string[]): { status: number; body: ICheckJson } {
  const r = shrk(cwd, [...argv, '--json']);
  try {
    return { status: r.status, body: JSON.parse(r.stdout) as ICheckJson };
  } catch {
    throw new Error(`did not print JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
}

describe('conventions check — an empty scope is NOT VERIFIED, never "ok — no violations"', () => {
  test(
    'no changed file (not a git repository): 2 in text and JSON; --allow-empty accepts it and says so',
    () => {
      const root = workspace('', { 'sharkcraft/conventions.ts': NAMING });
      const text = shrk(root, []);
      expect(text.status).toBe(ExitCode.NotVerified);
      expect(text.stdout).toContain('NOT VERIFIED');
      expect(text.stdout).not.toContain('ok — no violations');
      expect(text.stdout).toContain('Pass --allow-empty');

      const { status, body } = json(root, []);
      expect(status).toBe(ExitCode.NotVerified);
      expect(body.exitCode).toBe(ExitCode.NotVerified);
      expect(body.gate.exit).toBe(ExitCode.NotVerified);
      expect(body.gate.verdict).toBe('not-verified');
      // The top-level verdict never contradicts the exit (review: it said `clean` at 2).
      expect(body.verdict).toBe('not-verified');
      expect(body.gate.shortfalls.join('\n')).toContain('no file in the working-tree change');

      const accepted = shrk(root, ['--allow-empty']);
      expect(accepted.status).toBe(ExitCode.VerifiedPass);
      expect(accepted.stdout).toContain('accepted by --allow-empty');
      const acceptedJson = json(root, ['--allow-empty']).body;
      expect(acceptedJson.gate.accepted.length).toBeGreaterThan(0);
      expect(acceptedJson.verdict).toBe('clean');
    },
    T,
  );

  test(
    'no convention declared: 2 over real files; --allow-empty accepts the empty registry',
    () => {
      const root = workspace();
      const r = shrk(root, ['--files', 'src/good.ts']);
      expect(r.status).toBe(ExitCode.NotVerified);
      expect(r.stdout).toContain('NOT VERIFIED');
      expect(shrk(root, ['--files', 'src/good.ts', '--allow-empty']).status).toBe(ExitCode.VerifiedPass);
    },
    T,
  );

  test(
    'a convention file that never loaded: 2, and --allow-empty does NOT clear it (its conventions were never checked)',
    () => {
      const root = workspace("conventionFiles: ['missing.ts']");
      expect(shrk(root, ['--files', 'src/good.ts']).status).toBe(ExitCode.NotVerified);
      const r = json(root, ['--files', 'src/good.ts', '--allow-empty']);
      expect(r.status).toBe(ExitCode.NotVerified);
      expect(r.body.gate.shortfalls.join('\n')).toContain('convention files');
    },
    T,
  );

  test(
    'a real scope: an error-severity hit is 1; a clean file is 0 with the clean line',
    () => {
      const root = workspace('', { 'sharkcraft/conventions.ts': NAMING });
      const hit = shrk(root, ['--files', 'src/bad.ts']);
      expect(hit.status).toBe(ExitCode.Failure);
      expect(hit.stdout).toContain('c.names/no-bad');
      const clean = shrk(root, ['--files', 'src/good.ts']);
      expect(clean.status).toBe(ExitCode.VerifiedPass);
      expect(clean.stdout).toContain('ok — no violations.');
      expect(json(root, ['--files', 'src/good.ts']).body.gate.exit).toBe(ExitCode.VerifiedPass);
    },
    T,
  );
});

describe('conventions check is a registered verdict verb', () => {
  test('GATE_VERB_PATHS, the usage documents --allow-empty, a bad flag is 3', () => {
    expect(isGateVerb('conventions check')).toBe(true);
    expect(usageExitFor('conventions check')).toBe(ExitCode.UsageError);
    expect(conventionsCheckCommand.usage).toContain('--allow-empty');
    const root = workspace();
    const bad = shrk(root, ['--bogus']);
    expect(bad.status).toBe(ExitCode.UsageError);
    expect(bad.stderr).toContain('--bogus is not a flag of this command');
  }, T);
});
