/**
 * Round 11 (integration lane) — items 1, 3 and 5, locked at the surface a
 * consumer reads (exit code, --json, the printed line).
 *
 *   1. A glob-matched file over the one reader's 1MB cap is EXPECTED and
 *      UNEXAMINED on every plane, in every verb and every aggregate:
 *      `policy-lint`, `check wiring`, `gates check | coverage`, `registry`,
 *      `baseline check`, `generated check`, `quality`, `finish` and `shrk
 *      gate`. Before, a forbidden token in it read "examined 1 of 1 ✓", and a
 *      failOnEmpty rule whose only file was over the cap FAILED (1) as
 *      "matched nothing". Now every one of them is NOT VERIFIED (2), naming the
 *      file.
 *   3. ONE scan scope: a verb and its aggregate walk the same tree for the same
 *      rule. `shrk gate` and `check wiring` used to walk the SharkCraft dir that
 *      `policy-lint` and `gates check` prune, so a rule read 1 in one and 0 ✓
 *      in the other.
 *   5. `quality` labels a partial rule PART (not SKIP), and finish names a
 *      partial composite as partial (not "Nothing was verified").
 *
 * Every fixture is a real mkdtemp workspace through the real config loader and
 * the real engines, with a real file over the real cap on disk.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_SCAN_FILE_BYTES } from '@shrkcrft/boundaries';
import { buildFullIndex } from '@shrkcrft/graph';
import type { ParsedArgs } from '../command-registry.ts';
import { baselineCheckCommand } from '../commands/baseline.command.ts';
import { checkCommand } from '../commands/check.command.ts';
import { gateCommand } from '../commands/gate.command.ts';
import { gatesCheckCommand, gatesCoverageCommand } from '../commands/gates.command.ts';
import { generatedCheckCommand } from '../commands/generated.command.ts';
import { policyLintCommand } from '../commands/policy-lint.command.ts';
import { qualityCommand } from '../commands/quality.command.ts';
import { registryCommand } from '../commands/registry.command.ts';
import { ExitCode } from '../exit-codes.ts';
import { runFinishGates } from '../finish/run-finish.ts';

const SLOW = 180_000;

// ── harness ────────────────────────────────────────────────────────────────

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
  let out = '';
  const sink = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(planes: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-readcap-cli-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), `export default { projectName: 'fx', ${planes} };\n`);
  return root;
}

function git(root: string, ...a: string[]): void {
  const res = spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${res.stderr ?? ''}`);
}

function committed(root: string): string {
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

/** A real file just over the one reader's cap: `body`, then padding. */
function overCap(body: string): string {
  return `${body}\n// ${'x'.repeat(MAX_SCAN_FILE_BYTES + 16)}\n`;
}

const FILES: Record<string, string> = {
  '.gitignore': '.sharkcraft/\n',
  'src/clean.ts': 'export const CLEAN_T = 1;\n',
  'src/big.ts': overCap('export const BIG_T = "FORBIDDEN_TOKEN";'),
  'src/reg.ts': 'export const T = [CLEAN_T];\n',
};

const POLICY = (files = "['src/**/*.ts']", severity = 'warning'): string =>
  `{ id: 'no-forbidden', surface: 'ts', files: ${files}, pattern: 'FORBIDDEN_TOKEN', message: 'no', severity: '${severity}' }`;
const WIRING =
  "{ id: 'tokens-wired', severity: 'warning', declared: { files: ['src/**/*.ts'], extract: 'export-names', match: '_T$' }, " +
  "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'T' } }";

const CLEAN_LINE = /\.\s*✓|— accepted\.\s*$/m;

/** Every surface names the file and the cap. */
function namesTheUnreadFile(out: string, file = 'src/big.ts'): void {
  expect(out).toContain(file);
  expect(out).toContain('over the 1MB read cap');
}

// ── 1. every verb ──────────────────────────────────────────────────────────

describe('item 1 — an over-cap file is expected-but-unexamined in every verb', () => {
  test('policy-lint: a forbidden token in an over-cap file is NOT VERIFIED (2), text ≡ --json, never ✓', async () => {
    const root = workspace(`policyRules: [ ${POLICY()} ]`, FILES);
    const text = await run(policyLintCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    namesTheUnreadFile(text.out);
    expect(text.out).not.toMatch(CLEAN_LINE);
    const json = JSON.parse((await run(policyLintCommand, args(root, [], { json: true }))).out);
    expect({ exit: json.exitCode, gate: json.gate.exit, status: json.gate.rules[0].status }).toEqual({
      exit: 2,
      gate: 2,
      status: 'partial',
    });
    // src/clean.ts and src/reg.ts were read; src/big.ts was not.
    expect(json.gate.rules[0].shortfall).toContain('examined 2 of 3 files, 1 over the 1MB read cap: src/big.ts');
  }, SLOW);

  test('policy-lint: a failOnEmpty rule whose only file is over the cap is 2 — never the failOnEmpty 1', async () => {
    const root = workspace(`policyRules: [ ${POLICY("['src/big.ts']", 'error')} ]`, FILES);
    const r = await run(policyLintCommand, args(root, []));
    expect(r.code).toBe(ExitCode.NotVerified);
    namesTheUnreadFile(r.out);
  }, SLOW);

  test('check wiring: the declared side over the cap is PARTIAL (2), text ≡ --json', async () => {
    const root = workspace(`wiringRules: [ ${WIRING} ]`, FILES);
    const text = await run(checkCommand, args(root, ['wiring']));
    expect(text.code).toBe(ExitCode.NotVerified);
    namesTheUnreadFile(text.out);
    const json = JSON.parse((await run(checkCommand, args(root, ['wiring'], { json: true }))).out);
    expect({ exit: json.exitCode, status: json.gate.rules[0].status }).toEqual({ exit: 2, status: 'partial' });
  }, SLOW);

  test('gates check and gates coverage: both rules PARTIAL (2); coverage never calls one "empty"', async () => {
    const root = workspace(`policyRules: [ ${POLICY("['src/big.ts']", 'error')} ], wiringRules: [ ${WIRING} ]`, FILES);
    const check = JSON.parse((await run(gatesCheckCommand, args(root, [], { json: true }))).out);
    expect(check.gate.exit).toBe(ExitCode.NotVerified);
    expect(check.gate.rules.map((r: { id: string; status: string }) => [r.id, r.status]).sort()).toEqual([
      ['no-forbidden', 'partial'],
      ['tokens-wired', 'partial'],
    ]);
    const cov = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    expect(cov.gate.exit).toBe(ExitCode.NotVerified);
    expect(cov.rules.map((r: { status: string }) => r.status)).not.toContain('empty');
    expect(cov.gate.rules.map((r: { status: string }) => r.status)).toEqual(['partial', 'partial']);
  }, SLOW);

  test('registry: only a positive finding survives an incomplete inventory', async () => {
    const root = workspace(
      "registries: [ { name: 'exports', source: { files: ['src/**/*.ts'], extract: 'export-names' } } ]",
      FILES,
    );
    const list = await run(registryCommand, args(root, ['exports', 'list']));
    expect(list.code).toBe(ExitCode.NotVerified);
    namesTheUnreadFile(list.out);
    // "no" over an unread file is not verified; neither is the --fail-if-taken "free" 0.
    expect((await run(registryCommand, args(root, ['exports', 'exists', 'BIG_T']))).code).toBe(ExitCode.NotVerified);
    expect(
      (await run(registryCommand, args(root, ['exports', 'exists', 'BIG_T'], { 'fail-if-taken': true }))).code,
    ).toBe(ExitCode.NotVerified);
    expect((await run(registryCommand, args(root, ['exports', 'duplicates']))).code).toBe(ExitCode.NotVerified);
    // An id found among the files read IS declared.
    expect((await run(registryCommand, args(root, ['exports', 'exists', 'CLEAN_T']))).code).toBe(ExitCode.VerifiedPass);
  }, SLOW);

  test('baseline check: an extractor ledger over an over-cap file is NOT VERIFIED (2)', async () => {
    const root = workspace(
      "baselines: [ { id: 'exports-ledger', baseline: 'exports.json', compute: { kind: 'extractor', source: { files: ['src/**/*.ts'], extract: 'export-names' } } } ]",
      { ...FILES, 'exports.json': `${JSON.stringify(['CLEAN_T', 'T'], null, 2)}\n` },
    );
    const r = await run(baselineCheckCommand, args(root, []));
    expect(r.code).toBe(ExitCode.NotVerified);
    namesTheUnreadFile(r.out);
  }, SLOW);

  test('generated check: an over-cap committed file was never checked — NOT VERIFIED (2)', async () => {
    const root = workspace(
      "generatedArtifacts: [ { id: 'gen', generatedGlob: ['gen/**'], provenanceHeader: { mustMatch: 'GENERATED' } } ]",
      {
        'gen/a.txt': 'GENERATED\nbody\n',
        'gen/big.txt': overCap('GENERATED'),
      },
    );
    const r = await run(generatedCheckCommand, args(root, []));
    expect(r.code).toBe(ExitCode.NotVerified);
    namesTheUnreadFile(r.out, 'gen/big.txt');
  }, SLOW);
});

// ── 1 + 5. the aggregates ───────────────────────────────────────────────────

describe('item 1 + 5 — the aggregates carry the same record, and label it PARTIAL', () => {
  test('quality: the policy rule is a PART item (status skipped, partial: true) and the run is 2', async () => {
    const root = workspace(`policyRules: [ ${POLICY()} ]`, FILES);
    const json = JSON.parse((await run(qualityCommand, args(root, [], { json: true }))).out);
    expect(json.exitCode).toBe(ExitCode.NotVerified);
    const item = json.items.find((i: { id: string }) => i.id === 'policy:no-forbidden');
    expect({ status: item.status, partial: item.partial }).toEqual({ status: 'skipped', partial: true });
    expect(item.notes.join('\n')).toContain('src/big.ts');
    expect(json.coverage.reason).toContain('examined only part of their scope');
    const text = await run(qualityCommand, args(root, []));
    expect(text.out).toMatch(/^ {2}PART {3}\[policy\] no-forbidden$/m);
    expect(text.out).not.toMatch(/^ {2}SKIP {3}\[policy\] no-forbidden$/m);
  }, SLOW);

  test('finish: a changed over-cap file makes the policy sub-gate partial, and the next action says PART of the scope', async () => {
    const root = committed(workspace(`policyRules: [ ${POLICY()} ]`, FILES));
    writeFileSync(join(root, 'src', 'big.ts'), overCap('export const BIG_T = "FORBIDDEN_TOKEN"; // edited'));
    const report = await runFinishGates({ cwd: root, mode: 'worktree', scope: { projectRoot: root, includeWorktree: true } });
    const policy = report.gates.find((g) => g.name === 'policy');
    expect({ status: policy?.status, exit: report.exit }).toEqual({ status: 'partial', exit: ExitCode.NotVerified });
    // The sub-gate's shortfall names the rule; its detail carries the rule's
    // own shortfall, which names the unread file.
    expect(policy?.shortfall).toContain('no-forbidden');
    expect(policy?.shortfall).toContain('examined only part of their scope');
    expect(policy?.detail).toContain('examined 0 of 1 files, 1 over the 1MB read cap: src/big.ts');
    expect(report.nextAction).toContain('Part of the changed scope was not verified');
  }, SLOW);

  test('shrk gate: the policy gate is NOT VERIFIED over an over-cap file (2), like policy-lint', async () => {
    const root = committed(workspace(`policyRules: [ ${POLICY()} ]`, FILES));
    buildFullIndex({ projectRoot: root });
    const json = JSON.parse((await run(gateCommand, args(root, [], { 'no-persist': true, json: true }))).out);
    const policy = json.gates.find((g: { id: string }) => g.id === 'policy');
    expect(policy.status).toBe('warn');
    expect(policy.message).toContain('src/big.ts');
    expect(json.exitCode).toBe(ExitCode.NotVerified);
  }, SLOW);
});

// ── 3. one scan scope ───────────────────────────────────────────────────────

describe('item 3 — a verb and its aggregate walk the same tree for the same rule', () => {
  /**
   * Both rules glob `**\/*.ts`. The only offending content sits in the
   * SharkCraft dir: the config itself holds the policy pattern (a rule
   * self-matching its own definition), and `sharkcraft/extra.ts` declares a
   * `_W` token nothing registers. THE scan scope prunes that dir everywhere.
   */
  function scopeWorkspace(): string {
    const root = workspace(
      "policyRules: [ { id: 'no-marker', surface: 'ts', files: ['**/*.ts'], pattern: 'SCOPE_MARKER', message: 'm', severity: 'error' } ], " +
        "wiringRules: [ { id: 'w-wired', declared: { files: ['**/*.ts'], extract: 'export-names', match: '_W$' }, registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'W' } } ]",
      {
        '.gitignore': '.sharkcraft/\n',
        'src/a.ts': 'export const A_W = 1;\n',
        'src/reg.ts': 'export const W = [A_W];\n',
        'sharkcraft/extra.ts': 'export const GHOST_W = 1; // SCOPE_MARKER\n',
      },
    );
    return committed(root);
  }

  test('policy-lint ≡ gates check ≡ shrk gate ≡ finish; check wiring ≡ gates check ≡ shrk gate ≡ finish', async () => {
    const root = scopeWorkspace();
    buildFullIndex({ projectRoot: root });

    const policyVerb = JSON.parse((await run(policyLintCommand, args(root, [], { json: true }))).out);
    const wiringVerb = JSON.parse((await run(checkCommand, args(root, ['wiring'], { json: true }))).out);
    const aggregate = JSON.parse((await run(gatesCheckCommand, args(root, [], { json: true }))).out);
    const gate = JSON.parse((await run(gateCommand, args(root, [], { 'no-persist': true, json: true }))).out);

    const statusOf = (env: { rules: { id: string; status: string }[] }, id: string): string | undefined =>
      env.rules.find((r) => r.id === id)?.status;
    // The verbs examined the same files the aggregate did: both rules pass everywhere.
    expect({
      policyVerb: statusOf(policyVerb.gate, 'no-marker'),
      policyAggregate: statusOf(aggregate.gate, 'no-marker'),
      wiringVerb: statusOf(wiringVerb.gate, 'w-wired'),
      wiringAggregate: statusOf(aggregate.gate, 'w-wired'),
    }).toEqual({ policyVerb: 'passed', policyAggregate: 'passed', wiringVerb: 'passed', wiringAggregate: 'passed' });
    expect({ policyVerb: policyVerb.exitCode, wiringVerb: wiringVerb.exitCode, aggregate: aggregate.gate.exit }).toEqual({
      policyVerb: 0,
      wiringVerb: 0,
      aggregate: 0,
    });
    // `shrk gate` used to walk the SharkCraft dir: policy FAILED on the rule's own
    // definition and wiring FAILED on GHOST_W.
    expect({
      policy: gate.gates.find((g: { id: string }) => g.id === 'policy').status,
      wiring: gate.gates.find((g: { id: string }) => g.id === 'wiring').status,
    }).toEqual({ policy: 'pass', wiring: 'pass' });

    // finish walks the same tree for a change to src/a.ts.
    writeFileSync(join(root, 'src', 'a.ts'), 'export const A_W = 2;\n');
    const finish = await runFinishGates({ cwd: root, mode: 'worktree', scope: { projectRoot: root, includeWorktree: true } });
    expect({
      policy: finish.gates.find((g) => g.name === 'policy')?.status,
      wiring: finish.gates.find((g) => g.name === 'wiring')?.status,
    }).toEqual({ policy: 'pass', wiring: 'pass' });
  }, SLOW);
});
