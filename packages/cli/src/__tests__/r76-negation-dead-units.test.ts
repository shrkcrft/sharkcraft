/**
 * Round 12 (12.2) — a negation is judged by what it EXCLUDES.
 *
 * `gates coverage` reported every `!` glob as a dead unit "matched 0 files"
 * with "Fix or remove them" advice, and `--fail-on-dead-units` failed it — so
 * the flag was unusable in any repo whose rules exclude their tests. (Against
 * the pre-round-12 engine the report was literally true: the negation did
 * nothing. It is fixed together with 12.2a, so the counter reads the same
 * authority the engines select with.)
 *
 * Now: a negation is alive iff it removes at least one file from its own list's
 * positive set, and is reported with that count; a negation that removes
 * nothing is dead and says "excludes nothing"; an inclusion glob whose every
 * match is excluded says so. Exits are unchanged: dead units stay advisory
 * unless `--fail-on-dead-units`. Real configs, real handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_SCAN_FILE_BYTES } from '@shrkcrft/boundaries';
import { inspectSharkcraft, type IQualityConfig } from '@shrkcrft/inspector';
import type { ParsedArgs } from '../command-registry.ts';
import { gatesCoverageCommand, prepare } from '../commands/gates.command.ts';
import { ExitCode } from '../exit-codes.ts';
import { runQuality } from '../quality/run-quality.ts';

const SLOW = 180_000;

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function coverage(root: string, flags: Record<string, string | boolean> = {}): Promise<{ code: number; out: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  const sink = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    return { code: await gatesCoverageCommand.run(args(root, [], flags)), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
const locked: string[] = [];
afterAll(() => {
  for (const d of locked) chmodSync(d, 0o755);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'src/handlers/a.ts': 'export const A_HANDLER = 1;\n',
  'src/handlers/a.spec.ts': 'export const SPEC_HANDLER = 3;\n',
  'src/registry.ts': 'export const HANDLERS = [A_HANDLER];\n',
};

/** The spec's repo shape. */
const LIST = ['src/**/*.ts', '!src/**/*.spec.ts'];

function wiring(files: readonly string[]): Record<string, unknown> {
  return {
    id: 'handlers-registered',
    declared: { files, extract: 'export-names', match: '_HANDLER$' },
    registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
  };
}

function policy(files: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'no-todo', surface: 'ts', files, pattern: 'TODO', message: 'no todo', ...extra };
}

function workspace(config: Record<string, unknown>, extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-deadneg-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), `export default ${JSON.stringify(config, null, 2)};\n`);
  for (const [rel, body] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

type Row = Record<string, unknown> & { id: string; deadGlobs: string[] };

function rowOf(body: { rules: Row[] }, id: string): Row {
  return body.rules.find((r) => r.id === id)!;
}

const DEAD_NEGATION_REASON = 'excludes nothing — none of the 3 file(s) the other globs select match it';

describe('12.2 — a load-bearing negation is not a dead unit', () => {
  test("the spec's shape: no dead glob, the negation reported with what it excludes, the unqualified ✓", async () => {
    const root = workspace({ wiringRules: [wiring(LIST)], policyRules: [policy(LIST)] });
    const body = JSON.parse((await coverage(root, { json: true })).out);
    expect(rowOf(body, 'handlers-registered').deadGlobs).toEqual([]);
    expect(rowOf(body, 'no-todo').deadGlobs).toEqual([]);
    expect(body.deadGlobCount).toBe(0);
    expect(rowOf(body, 'handlers-registered')['negations']).toEqual([
      { selector: 'declared: !src/**/*.spec.ts', excludes: 1 },
    ]);
    expect(rowOf(body, 'no-todo')['negations']).toEqual([{ selector: '!src/**/*.spec.ts', excludes: 1 }]);

    const text = await coverage(root);
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('Every rule is connected to something. ✓');
    expect(text.out).not.toContain('⚠');
    expect(text.out).not.toContain('matched 0 files');
    expect(text.out).toContain('excludes: declared: !src/**/*.spec.ts (1 file)');
  }, SLOW);

  test('--fail-on-dead-units passes a load-bearing exclusion — in text and --json', async () => {
    const root = workspace({ wiringRules: [wiring(LIST)], policyRules: [policy(LIST)] });
    const json = await coverage(root, { json: true, 'fail-on-dead-units': true });
    expect(json.code).toBe(ExitCode.VerifiedPass);
    expect(JSON.parse(json.out).gate.exit).toBe(ExitCode.VerifiedPass);
    expect((await coverage(root, { 'fail-on-dead-units': true })).code).toBe(ExitCode.VerifiedPass);
  }, SLOW);

  test('a negation whose only excluded file is over the read cap is alive — and the rule is not PARTIAL', async () => {
    const root = workspace(
      { policyRules: [policy(['src/**/*.ts', '!src/big.ts'])] },
      { 'src/big.ts': `// TODO hidden\n// ${'x'.repeat(MAX_SCAN_FILE_BYTES + 16)}\n` },
    );
    const body = JSON.parse((await coverage(root, { json: true, 'fail-on-dead-units': true })).out);
    const row = rowOf(body, 'no-todo');
    expect(row.deadGlobs).toEqual([]);
    expect(row['negations']).toEqual([{ selector: '!src/big.ts', excludes: 1 }]);
    expect(body.gate.rules[0].status).toBe('passed');
    expect(body.gate.exit).toBe(ExitCode.VerifiedPass);
  }, SLOW);

  test('the watchFiles probe reads the same decision — a live negation, and no dead glob beneath an unlistable directory', async () => {
    const root = workspace(
      {
        baselines: [
          {
            id: 'cmd-ledger',
            baseline: 'ledger.json',
            compute: { kind: 'command', run: 'echo []' },
            watchFiles: ['src/**/*.ts', '!src/**/*.spec.ts', 'vendor/locked/**'],
          },
        ],
      },
      { 'ledger.json': '[]\n', 'vendor/locked/x.ts': 'export const X = 1;\n' },
    );
    // Unlistable, so its files are never enumerated. (As root it stays
    // listable and the glob matches x.ts directly — alive either way.)
    const dir = join(root, 'vendor', 'locked');
    chmodSync(dir, 0o000);
    locked.push(dir);
    const row = rowOf(JSON.parse((await coverage(root, { json: true })).out), 'cmd-ledger');
    expect(row.deadGlobs).toEqual([]);
    expect(row['negations']).toEqual([{ selector: '!src/**/*.spec.ts', excludes: 1 }]);
    expect(row['sampleIds']).not.toContain('src/handlers/a.spec.ts');
  }, SLOW);
});

describe('12.2 — a genuinely dead unit says why', () => {
  test('a negation that excludes nothing is dead — "excludes nothing", and --fail-on-dead-units fails with that reason', async () => {
    const root = workspace({ wiringRules: [wiring(['src/**/*.ts', '!src/nowhere/**'])] });
    const body = JSON.parse((await coverage(root, { json: true })).out);
    const row = rowOf(body, 'handlers-registered');
    expect(row.deadGlobs).toEqual(['declared: !src/nowhere/**']);
    expect(row['deadGlobUnits']).toEqual([
      { selector: 'declared: !src/nowhere/**', glob: '!src/nowhere/**', negation: true, reason: DEAD_NEGATION_REASON },
    ]);
    expect(row['negations']).toEqual([]);
    expect(body.deadGlobCount).toBe(1);

    const text = await coverage(root);
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain(`⚠ 1 of 3 glob(s) dead: declared: !src/nowhere/** (${DEAD_NEGATION_REASON})`);
    expect(text.out).not.toContain('matched 0 files');

    const failed = JSON.parse((await coverage(root, { json: true, 'fail-on-dead-units': true })).out);
    expect(failed.gate.exit).toBe(ExitCode.Failure);
    expect(failed.gate.rules[0].violations.map((v: { id: string; message: string }) => ({ id: v.id, message: v.message }))).toEqual([
      { id: 'declared: !src/nowhere/**', message: `${DEAD_NEGATION_REASON} (--fail-on-dead-units)` },
    ]);
    expect((await coverage(root, { 'fail-on-dead-units': true })).code).toBe(ExitCode.Failure);
  }, SLOW);

  test("an inclusion glob whose every match the list excludes is dead — \"matches only files the list's negations exclude\"", async () => {
    const root = workspace({ policyRules: [policy(['src/**/*.ts', 'src/handlers/a.spec.ts', '!**/*.spec.ts'])] });
    const row = rowOf(JSON.parse((await coverage(root, { json: true })).out), 'no-todo');
    expect(row['deadGlobUnits']).toEqual([
      {
        selector: 'src/handlers/a.spec.ts',
        glob: 'src/handlers/a.spec.ts',
        negation: false,
        reason: "matches only files the list's negations exclude (1)",
      },
    ]);
    expect(row['negations']).toEqual([{ selector: '!**/*.spec.ts', excludes: 1 }]);
  }, SLOW);

  test("a soft-empty rule's dead units are not counted or failed — the reportsDeadGlobs invariant", async () => {
    const root = workspace({ policyRules: [policy(['nowhere/**/*.ts', '!nowhere/**/*.spec.ts'], { severity: 'warning' })] });
    const body = JSON.parse((await coverage(root, { json: true })).out);
    const row = rowOf(body, 'no-todo');
    expect(row['status']).toBe('empty');
    expect((row['deadGlobUnits'] as { reason: string }[]).map((u) => u.reason)).toEqual([
      'matched 0 files',
      'excludes nothing — none of the 0 file(s) the other globs select match it',
    ]);
    expect(body.deadGlobCount).toBe(0);
    // Its "matched nothing" verdict stands: 2, never promoted to 1 by the flag.
    expect((await coverage(root, { 'fail-on-dead-units': true })).code).toBe(ExitCode.NotVerified);
  }, SLOW);
});

describe('shrk quality words it the same way', () => {
  async function quality(config: Record<string, unknown>) {
    const root = workspace(config);
    const prep = await prepare(args(root, []));
    if (!prep.ok) throw new Error('config did not load');
    return runQuality({
      inspection: await inspectSharkcraft({ cwd: root }),
      config: {} as IQualityConfig,
      strict: false,
      failFast: false,
      cwd: root,
      excludeDirs: prep.value.excludeDirs,
      gateRules: prep.value.rules,
    });
  }

  test('a dead negation rides along as an advisory note on a passing coverage item, with its reason', async () => {
    const result = await quality({ wiringRules: [wiring(['src/**/*.ts', '!src/nowhere/**'])] });
    const item = result.items.find((i) => i.id === 'gates-coverage');
    expect(item?.status).toBe('passed');
    expect(item?.notes.join('\n')).toContain(
      `advisory: 1 dead glob(s): declared: !src/nowhere/** (${DEAD_NEGATION_REASON})`,
    );
  }, SLOW);

  test('a load-bearing negation adds no note at all', async () => {
    const result = await quality({ wiringRules: [wiring(LIST)] });
    const item = result.items.find((i) => i.id === 'gates-coverage');
    expect(item?.status).toBe('passed');
    expect(item?.notes.join('\n')).not.toContain('dead glob');
  }, SLOW);
});
