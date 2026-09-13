/**
 * Round 11 §3.2 — `shrk conventions doctor` settles against the convention
 * FILES it read. It used to print "ok — no load/validation issues." and exit 0
 * with no convention at all, and over a file that failed to import (a
 * `warning`); a closed-union value outside its set (reference kind, severity)
 * was not even an issue.
 *
 * Exit 0 · 1 an invalid convention (or a shape warning under --strict) · 2 a
 * convention file never read, or none discovered (`--allow-empty` accepts only
 * the latter). Real workspaces through the real command handler.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import { conventionsDoctorCommand } from '../commands/conventions.command.ts';
import { ExitCode } from '../exit-codes.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function args(root: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional: [],
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(a: ParsedArgs): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await conventionsDoctorCommand.run(a), out };
  } finally {
    process.stdout.write = orig;
  }
}

function workspace(config: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-conv-cli-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), `export default { projectName: 'fx'${config ? `, ${config}` : ''} };\n`);
  return root;
}

const OK = "{ id: 'c.ok', title: 'Ok', kind: 'naming', severity: 'warning', rules: [] }";
const conventions = (...items: string[]): Record<string, string> => ({
  'sharkcraft/conventions.ts': `export default [\n  ${items.join(',\n  ')},\n];\n`,
});

describe('conventions doctor — 0 / 1 / 2', () => {
  test('a shape warning passes (0) and fails under --strict (1)', async () => {
    const root = workspace('', conventions("{ id: 'c.extra', title: 'Extra', kind: 'naming', severity: 'info', rules: [], owner: 'x' }"));
    const t = await run(args(root));
    expect(t.code).toBe(ExitCode.VerifiedPass);
    expect(t.out).toContain('[convention-shape] c.extra');
    expect(t.out).toContain('No blocking convention issues — 1 warning(s) reported above.');
    expect((await run(args(root, { strict: true }))).code).toBe(ExitCode.Failure);
  }, 60_000);

  test('a reference kind outside the vocabulary is an error naming the allowed kinds (1)', async () => {
    const root = workspace(
      '',
      conventions(OK, "{ id: 'c.bad', title: 'Bad', kind: 'naming', severity: 'warning', rules: [], references: [{ kind: 'not-a-real-kind', value: 'v' }] }"),
    );
    const t = await run(args(root));
    expect(t.code).toBe(ExitCode.Failure);
    expect(t.out).toContain('expected one of: file, doc, command, knowledge, rule');
  }, 60_000);

  test('no convention file at all → NOT VERIFIED (2); --allow-empty accepts it (0)', async () => {
    const root = workspace('');
    const t = await run(args(root));
    expect(t.code).toBe(ExitCode.NotVerified);
    expect(t.out).toContain('NOT VERIFIED');
    expect(t.out).not.toContain('ok — no load/validation issues');
    const accepted = await run(args(root, { 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('No conventions declared — accepted.');
  }, 60_000);

  test('a convention file that never loaded is NOT VERIFIED (2), and --allow-empty does not clear it', async () => {
    const root = workspace("conventionFiles: ['missing.ts']");
    const t = await run(args(root));
    expect(t.code).toBe(ExitCode.NotVerified);
    expect(t.out).toContain('sharkcraft/missing.ts — failed to load');
    expect((await run(args(root, { 'allow-empty': true }))).code).toBe(ExitCode.NotVerified);
    const parsed = JSON.parse((await run(args(root, { json: true }))).out);
    expect([parsed.exitCode, parsed.files.discovered, parsed.files.unread.length]).toEqual([ExitCode.NotVerified, 1, 1]);
  }, 60_000);

  test('a clean convention file passes (0) in text and JSON', async () => {
    const root = workspace('', conventions(OK));
    const t = await run(args(root));
    expect(t.code).toBe(ExitCode.VerifiedPass);
    const parsed = JSON.parse((await run(args(root, { json: true }))).out);
    expect([parsed.exitCode, parsed.conventions, parsed.verdict]).toEqual([ExitCode.VerifiedPass, 1, 'pass']);
  }, 60_000);
});
