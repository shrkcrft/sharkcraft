/**
 * Round 11 (4.3#1, 4.3#5) — a selfTest names what it consulted, never asserts
 * a fake "got 0", and an empty inventory answers nothing.
 *
 *   • A `command` baseline with no `watchFiles` has no extracted set without
 *     spawning the command; its selfTest was a permanently red "got 0". It is
 *     now `not-evaluable` — a misconfiguration, named with the reason.
 *   • A `command` baseline WITH watchFiles exposed only the first five probed
 *     paths, in walk order; `expectIds` naming the sixth failed forever.
 *   • Every failure names the selector it consulted and the unit it counted.
 *   • `failOnEmpty` on registries[] / registrationGraph[] (was a load error).
 *   • `registry <name> exists|where|list|duplicates` over an inventory that
 *     matched NOTHING never answers the membership question: `--fail-if-taken`
 *     used to report "free" (0) over a stale glob.
 *
 * Real configs through the real handlers; the pack case goes through the real
 * pack-plane merge seam (`resolveProjectConfig`).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveProjectConfig } from '@shrkcrft/inspector';
import { clearPackDiscoveryCache } from '@shrkcrft/packs';
import {
  gatesCheckCommand,
  gatesCoverageCommand,
  gatesListCommand,
  gatesTryCommand,
} from '../commands/gates.command.ts';
import { registryCommand } from '../commands/registry.command.ts';
import { collectGateRules } from '../gates/gate-rule-view.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

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
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let body = '';
  const sink = ((c: string | Uint8Array): boolean => {
    body += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    const code = await h.run(a);
    return { code, out: body };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function workspace(config: Record<string, unknown>, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-st-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default ${JSON.stringify(config, null, 2)};\n`,
  );
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

async function coverageJson(root: string): Promise<{ code: number; body: { rules: Record<string, unknown>[] } }> {
  const r = await run(gatesCoverageCommand, args(root, [], { json: true }));
  return { code: r.code, body: JSON.parse(r.out) };
}

describe('4.3#5 — the command baseline: not-evaluable, and every probed path', () => {
  const LEDGER = { 'sharkcraft/ledger.txt': 'a\n' };

  test('no watchFiles + a selfTest → a named misconfiguration, never a fake "got 0"', async () => {
    const baseline = {
      id: 'ledger',
      baseline: 'sharkcraft/ledger.txt',
      compute: { kind: 'command', run: 'echo a' },
      selfTest: { expectMatchesAtLeast: 1, expectIds: ['x'] },
    };
    const root = workspace({ baselines: [baseline] }, LEDGER);
    const { code, body } = await coverageJson(root);
    const cov = body.rules[0]!;
    expect(cov['status']).toBe('error');
    expect(String(cov['error'])).toContain('cannot be evaluated');
    expect(String(cov['error'])).toContain('watchFiles');
    expect(cov['expectationFailures']).toEqual([]);
    const checks = cov['selfTestChecks'] as { status: string }[];
    expect(checks.map((c) => c.status)).toEqual(['not-evaluable', 'not-evaluable']);
    expect(code).toBe(ExitCode.Failure);

    // The dry-run evaluates it with the SAME evaluator, and says so.
    const file = join(root, 'b.json');
    writeFileSync(file, JSON.stringify(baseline));
    const tried = await run(gatesTryCommand, args(root, [], { 'rule-file': file }));
    expect(tried.code).toBe(ExitCode.Failure);
    expect(tried.out).toContain('NOT EVALUABLE');
  });

  test('with watchFiles, expectIds may name ANY probed path — the sixth file in the walk passes', async () => {
    const files: Record<string, string> = { ...LEDGER };
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) files[`src/${n}.ts`] = `export const ${n} = 1;\n`;
    const root = workspace(
      {
        baselines: [
          {
            id: 'ledger',
            baseline: 'sharkcraft/ledger.txt',
            compute: { kind: 'command', run: 'echo a' },
            watchFiles: ['src/*.ts'],
            selfTest: { expectMatchesAtLeast: 6, expectIds: ['src/f.ts'] },
          },
        ],
      },
      files,
    );
    const { code, body } = await coverageJson(root);
    const cov = body.rules[0]!;
    expect(cov['status']).toBe('ok');
    expect(cov['sampleIds']).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
    expect(code).toBe(ExitCode.VerifiedPass);
  });
});

describe('4.3#5 — every selfTest failure names the consulted selector and the unit', () => {
  test('registry, policy and wiring failures each say what they looked in and what they counted', async () => {
    const root = workspace(
      {
        registries: [
          { name: 'ids', source: { files: ['src/*.ts'], extract: 'export-names' }, selfTest: { expectMatchesAtLeast: 999 } },
        ],
        policyRules: [
          { id: 'p', surface: 'ts', files: ['src/*.ts'], pattern: 'export', message: 'm', selfTest: { expectMatchesAtLeast: 999 } },
        ],
        wiringRules: [
          {
            id: 'w',
            declared: { files: ['src/*.ts'], extract: 'export-names' },
            registered: { files: ['src/*.ts'], extract: 'export-names' },
            selfTest: { expectIds: ['NOPE'] },
          },
        ],
      },
      { 'src/a.ts': 'export const A = 1;\n' },
    );
    const { code, body } = await coverageJson(root);
    const failure = (id: string): string =>
      ((body.rules.find((r) => r['id'] === id)!['expectationFailures'] as string[]) ?? []).join(' | ');
    expect(failure('ids')).toContain('expected at least 999 ids, got 1');
    expect(failure('ids')).toContain('registry "ids" — source src/*.ts (export-names)');
    expect(failure('p')).toContain('expected at least 999 content units, got 1');
    expect(failure('p')).toContain('policy rule "p" — /export/ over src/*.ts');
    expect(failure('w')).toContain('not among the 1 declared tokens');
    expect(failure('w')).toContain('wiring rule "w" — declared src/*.ts (export-names)');
    expect(code).toBe(ExitCode.Failure);
  });
});

describe('4.3#1 — failOnEmpty on registries[] and registrationGraph[]', () => {
  const FILES = { 'src/tools/a.ts': 'export const alpha = 1;\n' };
  const stale = (extra: Record<string, unknown> = {}) => ({
    name: 'tools-stale',
    source: { files: ['src/old-tools/*.ts'], extract: 'export-names' },
    ...extra,
  });

  test('a registry with failOnEmpty loads, and a stale glob FAILS coverage and check (1)', async () => {
    const root = workspace({ registries: [stale({ failOnEmpty: true })] }, FILES);
    const list = await run(gatesListCommand, args(root, [], { json: true }));
    expect(list.code).toBe(ExitCode.VerifiedPass);
    expect(JSON.parse(list.out).rules[0].failOnEmpty).toBe(true);
    expect((await run(gatesCoverageCommand, args(root, []))).code).toBe(ExitCode.Failure);
    const check = await run(gatesCheckCommand, args(root, [], { json: true }));
    expect(check.code).toBe(ExitCode.Failure);
    expect(JSON.parse(check.out).gate.rules[0].status).toBe('failed');
    expect(JSON.parse(check.out).gate.rules[0].severity).toBe('error');
  });

  test('without the field the same registry stays not-verified (2) — back-compat', async () => {
    const root = workspace({ registries: [stale()] }, FILES);
    expect((await run(gatesCoverageCommand, args(root, []))).code).toBe(ExitCode.NotVerified);
    const check = await run(gatesCheckCommand, args(root, [], { json: true }));
    expect(check.code).toBe(ExitCode.NotVerified);
    expect(JSON.parse(check.out).gate.rules[0].status).toBe('skipped');
  });

  test('a registration idiom with failOnEmpty fails `gates check` when its graph matched nothing', async () => {
    const idiom = (extra: Record<string, unknown> = {}) => ({
      name: 'di',
      declared: { files: ['nowhere/*.ts'], extract: 'export-names' },
      provided: { files: ['nowhere/*.ts'], extract: 'export-names' },
      consumed: { files: ['nowhere/*.ts'], extract: 'export-names' },
      ...extra,
    });
    const failing = workspace({ registrationGraph: [idiom({ failOnEmpty: true })] }, FILES);
    expect((await run(gatesCheckCommand, args(failing, []))).code).toBe(ExitCode.Failure);
    const soft = workspace({ registrationGraph: [idiom()] }, FILES);
    expect((await run(gatesCheckCommand, args(soft, []))).code).toBe(ExitCode.NotVerified);
  });

  test('PROPERTY: over an empty inventory no query verb answers — 2 (1 with failOnEmpty), whatever the guard', async () => {
    const queries: { pos: string[]; flags?: Record<string, boolean> }[] = [
      { pos: ['list'] },
      { pos: ['exists', 'alpha'] },
      { pos: ['exists', 'alpha'], flags: { 'fail-if-taken': true } },
      { pos: ['exists', 'alpha'], flags: { 'fail-if-missing': true } },
      { pos: ['where', 'alpha'] },
      { pos: ['duplicates'] },
    ];
    for (const [failOnEmpty, expected] of [
      [false, ExitCode.NotVerified],
      [true, ExitCode.Failure],
    ] as const) {
      const root = workspace({ registries: [stale(failOnEmpty ? { failOnEmpty: true } : {})] }, FILES);
      for (const q of queries) {
        const label = `${q.pos.join(' ')} ${Object.keys(q.flags ?? {}).join(' ')} (failOnEmpty=${failOnEmpty})`;
        const text = await run(registryCommand, args(root, ['tools-stale', ...q.pos], { ...(q.flags ?? {}) }));
        const json = await run(registryCommand, args(root, ['tools-stale', ...q.pos], { ...(q.flags ?? {}), json: true }));
        const body = JSON.parse(json.out);
        expect({ label, text: text.code, json: json.code, exitCode: body.exitCode, verified: body.verified }).toEqual({
          label,
          text: expected,
          json: expected,
          exitCode: expected,
          verified: false,
        });
        // Never the membership answer over a scan that saw nothing.
        expect({ label, answered: /^(yes|no) — /m.test(text.out) }).toEqual({ label, answered: false });
        expect(text.out).toContain('matched 0 ids');
      }
    }
  });
});

describe('4.3#1 — a pack-contributed registry keeps failOnEmpty through the merge seam', () => {
  beforeEach(() => clearPackDiscoveryCache());

  test('resolveProjectConfig carries the field, and the gate view honours it', async () => {
    const root = workspace({ registries: [] }, { 'src/a.ts': 'export const A = 1;\n' });
    const packRoot = join(root, 'node_modules/@p75/reg-pack');
    mkdirSync(packRoot, { recursive: true });
    writeFileSync(
      join(packRoot, 'package.json'),
      JSON.stringify({ name: '@p75/reg-pack', version: '0.0.1', sharkcraft: { manifest: './sharkcraft.plugin.ts' } }),
    );
    writeFileSync(
      join(packRoot, 'sharkcraft.plugin.ts'),
      `export default {
  schema: 'sharkcraft.pack/v1',
  info: { name: '@p75/reg-pack', version: '0.0.1' },
  contributions: { registryFiles: ['./registries.ts'] },
};
`,
    );
    writeFileSync(
      join(packRoot, 'registries.ts'),
      `export default [
  { name: 'pack-reg', failOnEmpty: true, source: { files: ['lib/**/*.ts'], extract: 'export-names' } },
];
`,
    );
    const loaded = await resolveProjectConfig(root);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const reg = (loaded.value.config.registries ?? []).find((r) => r.name === 'pack-reg');
    expect(reg?.failOnEmpty).toBe(true);
    const view = collectGateRules(loaded.value.config).find((r) => r.id === 'pack-reg');
    expect(view?.failOnEmpty).toBe(true);
    // …and the stale pack registry fails coverage exactly as a local one would.
    expect((await run(gatesCoverageCommand, args(root, []))).code).toBe(ExitCode.Failure);
  });
});
