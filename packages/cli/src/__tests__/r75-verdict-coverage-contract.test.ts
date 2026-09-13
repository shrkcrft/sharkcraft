/**
 * Round 11 — coverage is a required field of every verdict, and a clean verdict
 * over an unexamined scope is forbidden.
 *
 * The bug class this locks: a verdict rendered in the vocabulary of the scope
 * it was ASKED about while it examined a smaller one. The live instance was a
 * subset wiring rule at `declared 2 / registered 3` that read `passed`, exit 0,
 * on `check wiring`, `gates check` and `gates coverage` alike — with the third
 * token printed on the same screen. (This repo's own `mcp-tool-registered` rule
 * sat at 282/284 the same way.)
 *
 * The contract has three parts, each locked here:
 *   1. `settleVerdict` — the one guard: a proposed 0 with a shortfall is 2; 1/2/3
 *      are never changed.
 *   2. `buildGateEnvelope` applies it, so `gate.exit` can never be 0 over a
 *      shortfall, and `verdictLine` is the only way a verb prints its ✓ line.
 *   3. `GATE_VERB_PATHS` is the verdict-verb registry; every entry has a row in
 *      the matrix below and every envelope verb is in it.
 *
 * Fixtures are real workspaces loaded through the real config loader and the
 * real inspector — never a hand-built inspection or registry shape.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { IVerdictCoverage } from '@shrkcrft/core';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { blankZoneKinds, lexCodeZones } from '@shrkcrft/boundaries';
import { checkCommand } from '../commands/check.command.ts';
import { finishCommand } from '../commands/finish.command.ts';
import { diffCheckCommand } from '../commands/diff-check.command.ts';
import {
  gatesCheckCommand,
  gatesCoverageCommand,
  gatesExplainCommand,
  prepare,
} from '../commands/gates.command.ts';
import { policyLintCommand } from '../commands/policy-lint.command.ts';
import { baselineCheckCommand } from '../commands/baseline.command.ts';
import { generatedCheckCommand } from '../commands/generated.command.ts';
import { docsReferencesCheckCommand } from '../commands/docs-references.command.ts';
import { reuseCoverageCommand } from '../commands/reuse-coverage.command.ts';
import { registryLifecycleCommand } from '../commands/registry.command.ts';
import { knowledgeStaleCheckCommand, knowledgeVerifyCommand } from '../commands/knowledge.command.ts';
import { conventionsCheckCommand } from '../commands/conventions.command.ts';
import { wiringCommand } from '../commands/wiring.command.ts';
import { buildGateEnvelope, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { emitPipeExitSignal, ExitCode, GATE_VERB_PATHS, isGateVerb, usageExitFor } from '../exit-codes.ts';
import { buildRegistry } from '../main.ts';
import { runQuality } from '../quality/run-quality.ts';
import type { ParsedArgs } from '../command-registry.ts';

// ── harness ────────────────────────────────────────────────────────────────

function args(
  root: string,
  positional: string[],
  flags: Record<string, string | boolean> = {},
): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

interface IRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<IRun> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await h.run(a);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A real workspace: package.json, the given files, and a real config. */
function workspace(planes: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'fx'${planes ? `, ${planes}` : ''} };\n`,
  );
  return root;
}

/** declared {A_H, B_H} ⊂ registered {A_H, B_H, C_H}: C_H has no declared site. */
const SUBSET_FILES: Record<string, string> = {
  'src/h/a.ts': 'export const A_H = 1;\n',
  'src/h/b.ts': 'export const B_H = 2;\n',
  'src/reg.ts': 'export const H = [A_H, B_H, C_H];\n',
};

function subsetRule(extra = ''): string {
  return (
    "wiringRules: [{ id: 'subset-rule', " +
    "declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' }, " +
    "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' }" +
    `${extra} }]`
  );
}

function notVerifiedLine(out: string): string {
  return out.split('\n').find((l) => l.startsWith('NOT VERIFIED:')) ?? '';
}

const FULL: IVerdictCoverage = { unit: 'rules', expected: 2, examined: 2 };
const PARTIAL: IVerdictCoverage = { unit: 'rules', expected: 2, examined: 1, unexamined: ['b'] };
const EMPTY: IVerdictCoverage = { unit: 'rules', expected: 0, examined: 0 };
const CAPPED: IVerdictCoverage = { unit: 'files', expected: 5, examined: 3, capped: true };

// ── 1. the guard ─────────────────────────────────────────────────────────────

describe('settleVerdict — the one exit guard', () => {
  test('a proposed 0 settles to 2 on any shortfall, and stays 0 without one', () => {
    expect(settleVerdict(0, [FULL])).toMatchObject({ exit: 0, verdict: 'pass', shortfalls: [] });
    for (const gap of [PARTIAL, EMPTY, CAPPED]) {
      const s = settleVerdict(0, [FULL, gap]);
      expect(s.exit).toBe(ExitCode.NotVerified);
      expect(s.verdict).toBe('not-verified');
      expect(s.shortfalls.length).toBe(1);
    }
  });

  test('1, 2 and 3 are never changed, whatever the coverage says', () => {
    for (const proposed of [ExitCode.Failure, ExitCode.NotVerified, ExitCode.UsageError]) {
      for (const cov of [[FULL], [PARTIAL], [EMPTY], [CAPPED], []]) {
        expect(settleVerdict(proposed, cov).exit).toBe(proposed);
      }
    }
  });

  test('an explicit acceptance settles to 0 and is reported, never silent', () => {
    const s = settleVerdict(0, [{ ...EMPTY, acceptedBy: '--allow-empty' }]);
    expect(s.exit).toBe(ExitCode.VerifiedPass);
    expect(s.accepted).toEqual(['accepted by --allow-empty: 0 rules to examine']);
  });

  test("a subject prefixes its shortfall, so a many-rule verdict names the rule", () => {
    expect(settleVerdict(0, [{ ...PARTIAL, subject: 'r1' }]).shortfalls[0]).toStartWith('r1: ');
  });

  test('an acceptance is reported ONLY when the settled exit is 0 — never next to a 1/2/3', () => {
    const accepted: IVerdictCoverage = { ...EMPTY, acceptedBy: '--allow-empty' };
    expect(settleVerdict(ExitCode.VerifiedPass, [accepted]).accepted.length).toBe(1);
    // A proposed 2 (e.g. an empty changeset proposed NotVerified) grants nothing.
    expect(settleVerdict(ExitCode.NotVerified, [accepted])).toMatchObject({ exit: 2, accepted: [] });
    // A failure, or another rule's shortfall that settles the run to 2, too.
    expect(settleVerdict(ExitCode.Failure, [accepted]).accepted).toEqual([]);
    expect(settleVerdict(ExitCode.VerifiedPass, [accepted, PARTIAL])).toMatchObject({ exit: 2, accepted: [] });
  });
});

describe('verdictLine — the only way a verb prints its clean sentence', () => {
  const CLEAN = 'Everything passed. ✓';

  test('the clean sentence appears iff the settled exit is 0', () => {
    for (const exit of [0, 1, 2, 3]) {
      for (const shortfalls of [[], ['x: examined 1 of 2 rules']]) {
        const line = verdictLine({ exit, verdict: 'pass', shortfalls, accepted: [] }, CLEAN, 'lead');
        expect(line.includes(CLEAN)).toBe(exit === 0);
      }
    }
  });

  test('a shortfall is ON the verdict line, marked as not a pass', () => {
    const line = verdictLine(settleVerdict(0, [{ ...PARTIAL, subject: 'r1' }]), CLEAN, 'lead text');
    expect(line).toBe('lead text\nNOT VERIFIED: r1: examined 1 of 2 rules, 1 not examined: b (this is not a pass)');
  });

  test('an accepted gap is printed beside the clean sentence', () => {
    const line = verdictLine(settleVerdict(0, [{ ...EMPTY, acceptedBy: '--allow-empty' }]), CLEAN);
    expect(line).toBe(`${CLEAN}\n  accepted by --allow-empty: 0 rules to examine`);
  });
});

describe('buildGateEnvelope — the guard lives inside the builder', () => {
  const rule = (over: Partial<IGateRuleResult>): IGateRuleResult => ({
    id: 'r1',
    type: 'wiring',
    status: 'passed',
    severity: 'error',
    counts: {},
    violations: [],
    coverage: FULL,
    ...over,
  });

  test('a passed rule with a shortfall is `partial`, and gate.exit is 2 though 0 was proposed', () => {
    const env = buildGateEnvelope('check wiring', 0, [rule({ coverage: PARTIAL })], FULL);
    expect(env.rules[0]?.status).toBe('partial');
    expect(env.rules[0]?.shortfall).toContain('examined 1 of 2 rules');
    expect(env).toMatchObject({ exit: 2, verdict: 'not-verified', partial: 1, evaluated: 1 });
    expect(env.shortfalls).toEqual(['r1: examined 1 of 2 rules, 1 not examined: b']);
  });

  test('a failed rule stays failed and 1 stays 1', () => {
    const env = buildGateEnvelope('gates check', 1, [rule({ status: 'failed', coverage: PARTIAL })], FULL);
    expect(env.rules[0]?.status).toBe('failed');
    expect(env.exit).toBe(1);
  });

  test("the run's own coverage vetoes a clean exit too", () => {
    expect(buildGateEnvelope('gates check', 0, [], EMPTY).exit).toBe(2);
  });

  test("a producer's own `shortfall` is ignored — the builder derives it", () => {
    const env = buildGateEnvelope('gates check', 0, [rule({ shortfall: 'forged' })], FULL);
    expect(env.rules[0]?.shortfall).toBeUndefined();
    expect(env.exit).toBe(0);
  });
});

// ── 2. the live bug: a subset rule at declared 2 / registered 3 ─────────────

describe('a subset wiring rule never passes over a registered token it did not examine', () => {
  test('check wiring: exit 2, C_H on the verdict line, the counts on the rule line', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const text = await run(checkCommand, args(root, ['wiring']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(notVerifiedLine(text.out)).toContain('C_H');
    expect(text.out).toContain('declared 2 / registered 3');
    expect(text.out).not.toContain('No wiring violations — every declared token is registered. ✓');

    const json = await run(checkCommand, args(root, ['wiring'], { json: true }));
    const parsed = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.NotVerified);
    expect(parsed.gate.exit).toBe(json.code);
    expect(parsed.gate.verdict).toBe('not-verified');
    expect(parsed.gate.rules[0].status).toBe('partial');
    expect(parsed.gate.rules[0].coverage.unexamined).toEqual(['C_H']);
    // The engine's one derivation rides on the plane payload too.
    expect(parsed.rules[0].registeredOnly.map((s: { token: string }) => s.token)).toEqual(['C_H']);
  });

  test('gates check: exit 2, and never "Every declared rule ran and passed"', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const text = await run(gatesCheckCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('Every declared rule ran and passed. ✓');
    expect(notVerifiedLine(text.out)).toContain('C_H');
    const json = await run(gatesCheckCommand, args(root, [], { json: true }));
    const gate = JSON.parse(json.out).gate;
    expect(gate.exit).toBe(json.code);
    expect(gate.rules[0].status).toBe('partial');
    expect(gate.rules[0].coverage.unexamined).toEqual(['C_H']);
  });

  test('gates coverage agrees — the registered side is inspected by the same engine', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const text = await run(gatesCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('Every rule is connected to something. ✓');
    const json = await run(gatesCoverageCommand, args(root, [], { json: true }));
    const gate = JSON.parse(json.out).gate;
    expect(gate.exit).toBe(json.code);
    expect(gate.rules[0].status).toBe('partial');
    expect(gate.rules[0].coverage.unexamined).toEqual(['C_H']);
  });

  test('explain shows the same set, labelled as never examined', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const { out } = await run(gatesExplainCommand, args(root, ['subset-rule']));
    expect(out).toContain('Registered with NO declared site');
    expect(out).toContain('C_H');
  });

  test('parity renders the SAME set as a violation (one derivation, two renderings)', async () => {
    const root = workspace(subsetRule(", mode: 'parity'"), SUBSET_FILES);
    const json = await run(checkCommand, args(root, ['wiring'], { json: true }));
    const gate = JSON.parse(json.out).gate;
    expect(json.code).toBe(ExitCode.Failure);
    expect(gate.rules[0].violations.map((v: { id: string }) => v.id)).toEqual(['C_H']);
  });

  test('registeredExtras accepts the known extra explicitly — exit 0, and the acceptance is printed', async () => {
    const root = workspace(subsetRule(", registeredExtras: ['C_H']"), SUBSET_FILES);
    const wiring = await run(checkCommand, args(root, ['wiring']));
    expect(wiring.code).toBe(ExitCode.VerifiedPass);
    expect(wiring.out).toContain('accepted by registeredExtras');
    const gates = await run(gatesCheckCommand, args(root, []));
    expect(gates.code).toBe(ExitCode.VerifiedPass);
    expect(gates.out).toContain('accepted by registeredExtras');
    expect((await run(gatesCoverageCommand, args(root, []))).code).toBe(ExitCode.VerifiedPass);
  });

  test("registeredExtras is literal: listing another id accepts nothing; 'allow' accepts all", async () => {
    const other = workspace(subsetRule(", registeredExtras: ['Z_H']"), SUBSET_FILES);
    expect((await run(checkCommand, args(other, ['wiring']))).code).toBe(ExitCode.NotVerified);
    const allow = workspace(subsetRule(", registeredExtras: 'allow'"), SUBSET_FILES);
    expect((await run(checkCommand, args(allow, ['wiring']))).code).toBe(ExitCode.VerifiedPass);
  });

  test('registeredExtras on a parity rule is refused at config load (usage error)', async () => {
    const root = workspace(subsetRule(", mode: 'parity', registeredExtras: ['C_H']"), SUBSET_FILES);
    expect((await run(gatesCheckCommand, args(root, []))).code).toBe(ExitCode.UsageError);
  });
});

// ── 3. --allow-empty ────────────────────────────────────────────────────────

describe('--allow-empty — "nothing to examine" is 2 unless accepted explicitly', () => {
  const verbs: { name: string; h: typeof checkCommand; pos: string[] }[] = [
    { name: 'check wiring', h: checkCommand, pos: ['wiring'] },
    { name: 'policy-lint', h: policyLintCommand, pos: [] },
    { name: 'gates check', h: gatesCheckCommand, pos: [] },
  ];

  for (const v of verbs) {
    test(`${v.name}: no rules declared → 2; --allow-empty → 0 with the acceptance printed`, async () => {
      const root = workspace('');
      const bare = await run(v.h, args(root, v.pos));
      expect(bare.code).toBe(ExitCode.NotVerified);
      const accepted = await run(v.h, args(root, v.pos, { 'allow-empty': true }));
      expect(accepted.code).toBe(ExitCode.VerifiedPass);
      expect(accepted.out).toContain('accepted by --allow-empty');
      const json = await run(v.h, args(root, v.pos, { 'allow-empty': true, json: true }));
      const gate = JSON.parse(json.out).gate;
      expect(gate.exit).toBe(json.code);
      expect(gate.coverage.expected).toBe(0);
      expect(gate.accepted.length).toBe(1);
    });
  }

  test('the valve never accepts rules that exist but checked nothing', async () => {
    const stale =
      "wiringRules: [{ id: 'stale', severity: 'warning', declared: { files: ['nowhere/*.ts'], extract: 'export-names' }, registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }]";
    const root = workspace(stale, SUBSET_FILES);
    expect((await run(checkCommand, args(root, ['wiring'], { 'allow-empty': true }))).code).toBe(
      ExitCode.NotVerified,
    );
  });
});

// ── 4. check orphans ────────────────────────────────────────────────────────

describe('check orphans — nothing deleted is not a pass', () => {
  function gitWorkspace(): string {
    const root = workspace('', SUBSET_FILES);
    const git = (...a: string[]): void => {
      spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', ...a], { cwd: root });
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return root;
  }

  test('exit 2 in text and JSON; --allow-empty accepts it and says so', async () => {
    const root = gitWorkspace();
    const text = await run(checkCommand, args(root, ['orphans']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    const json = await run(checkCommand, args(root, ['orphans'], { json: true }));
    const parsed = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.NotVerified);
    expect(parsed.skipped).toBe(true);
    expect(parsed.gate.exit).toBe(json.code);
    expect(parsed.gate.coverage.expected).toBe(0);
    const accepted = await run(checkCommand, args(root, ['orphans'], { 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('accepted by --allow-empty');
  });
});

// ── 5. quality ──────────────────────────────────────────────────────────────

describe('quality — a gate that examined nothing is never "passed"', () => {
  test('optional gates with nothing to examine are deliberate skips; the verdict is unaffected', async () => {
    const root = workspace('', { 'src/a.ts': 'export const A = 1;\n' });
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = await runQuality({
      inspection,
      config: {},
      strict: false,
      failFast: false,
      cwd: root,
      excludeDirs: [],
      gateRules: [],
    });
    for (const id of ['context-tests', 'agent-tests', 'boundaries']) {
      const item = r.items.find((i) => i.id === id);
      expect(item?.status).toBe('skipped');
      expect(item?.skippedDeliberately).toBe(true);
    }
    expect(r.items.some((i) => i.status === 'passed' && i.data?.['examinedNothing'] === true)).toBe(false);
    expect(r.coverage.unit).toBe('gates');
  });

  test('a REQUIRED gate that examined nothing is not verified (2), and says which', async () => {
    const root = workspace('', { 'src/a.ts': 'export const A = 1;\n' });
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = await runQuality({
      inspection,
      config: { requireContextTests: true },
      strict: false,
      failFast: false,
      cwd: root,
      excludeDirs: [],
      gateRules: [],
    });
    expect(r.items.find((i) => i.id === 'context-tests')?.skippedDeliberately).toBe(false);
    if (r.failed === 0) {
      expect(r.verdict).toBe('not-verified');
      expect(r.exit).toBe(ExitCode.NotVerified);
      expect(r.shortfalls.join(' ')).toContain('context-tests');
    }
  });

  test('a rule that passed over part of its scope is an ACCIDENTAL skip in quality', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const prep = await prepare(args(root, []));
    if (!prep.ok) throw new Error('fixture config failed to load');
    const inspection = await inspectSharkcraft({ cwd: root });
    const r = await runQuality({
      inspection,
      config: {},
      strict: false,
      failFast: false,
      cwd: root,
      excludeDirs: prep.value.excludeDirs,
      gateRules: prep.value.rules,
    });
    const item = r.items.find((i) => i.id === 'wiring:subset-rule');
    expect(item?.status).toBe('skipped');
    expect(item?.skippedDeliberately).not.toBe(true);
    expect(item?.notes.join(' ')).toContain('PARTIAL');
    expect(r.verdict).not.toBe('pass');
  });
});

// ── 6. the verdict-verb registry ────────────────────────────────────────────

/**
 * One row per verdict verb. `envelope` rows emit the settled `gate` envelope
 * today; `exit-contract` rows honour 0/1/2/3 and the pipe-safe channel, and are
 * wired into the envelope by the lanes that own their bodies.
 */
const MATRIX: Readonly<Record<string, 'envelope' | 'exit-contract'>> = {
  finish: 'envelope',
  gate: 'exit-contract',
  arch: 'exit-contract',
  doctor: 'exit-contract',
  'diff-check': 'envelope',
  // The bare sweep settles 0/1/2 via settleVerdict (a doctor shortfall is 2);
  // `--json` carries exitCode + verdict + shortfalls, not the gate envelope.
  check: 'exit-contract',
  'check boundaries': 'envelope',
  'check wiring': 'envelope',
  'check orphans': 'envelope',
  'check imports': 'exit-contract',
  'check registry-lifecycle': 'envelope',
  // Round 13 (P4): the registration-graph absence queries settle through the
  // gate envelope — every idiom's role record folded, so a dead declared role
  // is NOT VERIFIED, never a ✓; `--json` always carries `gate`.
  'wiring unprovided': 'envelope',
  'wiring orphans': 'envelope',
  // Round 13 review: the chain settles through the gate envelope too — every
  // involved idiom's role record folded, so a chain over a dead declared role
  // is NOT VERIFIED, never "✓ declared → provided → consumed".
  'wiring chain': 'envelope',
  registry: 'exit-contract',
  'registry lifecycle': 'envelope',
  'graph why': 'exit-contract',
  'graph cycles': 'exit-contract',
  'gates check': 'envelope',
  'gates coverage': 'envelope',
  quality: 'exit-contract',
  'policy-lint': 'envelope',
  'baseline check': 'envelope',
  // The bless step: 0 wrote · 1 a compute error · 2 refused over an incomplete
  // read (settleVerdict); `--json` carries exitCode + shortfalls.
  'baseline update': 'exit-contract',
  'generated check': 'envelope',
  'docs references check': 'envelope',
  'knowledge stale-check': 'envelope',
  'knowledge verify': 'envelope',
  'reuse coverage': 'envelope',
  'helper doctor': 'exit-contract',
  // Doctor lane (round 11 §1.3 / §1.6): settled via settleVerdict over the
  // engine's per-unit coverage; `--json` carries exitCode + shortfalls, not
  // the gate envelope.
  'self-config doctor': 'exit-contract',
  // Round 11 review: 0 none · 1 broken · 2 an id that could not be looked up,
  // or nothing to examine (`--allow-empty` accepts that).
  'self-config broken-links': 'exit-contract',
  // Round 13 (lane A): the report writer settles the self-config verdict
  // (settleVerdict); `--json` carries exitCode + settledVerdict + shortfalls + accepted.
  'self-config report': 'exit-contract',
  'registrations doctor': 'exit-contract',
  'scaffolds doctor': 'exit-contract',
  'search tuning doctor': 'exit-contract',
  // Packs lane (round 11 §1.4 / §3.2 / §3.3): settleVerdict over packs /
  // TS files / compiled artifacts / templates; `--json` carries exitCode +
  // verdict + shortfalls, not the gate envelope.
  'packs doctor': 'exit-contract',
  'packs release-check': 'exit-contract',
  'packs signature-status': 'exit-contract',
  'packs test': 'exit-contract',
  'templates doctor': 'exit-contract',
  // Knowledge lane (round 11 §3.2 / §4.6): settleVerdict over declared custom
  // checks / convention files; `--json` carries exitCode + shortfalls.
  'checks doctor': 'exit-contract',
  'conventions doctor': 'exit-contract',
  // Round 13: an empty file scope, no convention, or a convention file never
  // read is NOT VERIFIED (2) through the gate envelope; `--allow-empty`
  // accepts an empty scope / registry explicitly.
  'conventions check': 'envelope',
  // Doctor lane (round 11 review): settleVerdict over the tests examined;
  // `--json` carries exitCode + verdict + shortfalls, not the gate envelope.
  'test agent': 'exit-contract',
  'test context': 'exit-contract',
  // Dispatcher lane (round 11): the rule-authoring REPL settles its candidate's
  // selfTest through settleVerdict; `--json` carries no gate envelope.
  'gates try': 'exit-contract',
  // Round 11 review: the selfTest scaffolder's refusal over an incomplete scan
  // settles 2 through settleVerdict; `--json` carries exitCode.
  'gates scaffold-selftest': 'exit-contract',
  // Round 11 review (R11-GAP-5 / R11-GAP-3): verdict-shaped verbs the round
  // changed but never registered — hand-computed exits, or settled in the
  // inspector (`drift`, `architecture violations` over the boundary
  // orchestrator). `--json` carries exitCode, not the gate envelope.
  'checks list': 'exit-contract',
  'boundaries suggest': 'exit-contract',
  // Round 12 (ONE-CHANGE): exits {0,1,2} — 1 on a rejected entry / load
  // failure / error conflict, 2 when only unresolvable references remain
  // (settleVerdict); `--json` carries exitCode + verdict + shortfalls + report.
  'packs contributions': 'exit-contract',
  'self-config resolve': 'exit-contract',
  recommend: 'exit-contract',
  drift: 'exit-contract',
  'architecture violations': 'exit-contract',
};

function cliSources(): { rel: string; text: string }[] {
  const srcRoot = resolve(import.meta.dir, '..');
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '__tests__' || name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) out.push({ rel: relative(srcRoot, p), text: readFileSync(p, 'utf8') });
    }
  };
  walk(srcRoot);
  return out;
}

describe('the verdict-verb registry and the contract cannot drift apart', () => {
  test('every registry entry has a matrix row, and every row is registered', () => {
    expect([...GATE_VERB_PATHS].sort()).toEqual(Object.keys(MATRIX).sort());
  });

  test('every verb that builds a gate envelope is a registered verdict verb', () => {
    const verbs = new Set<string>();
    for (const f of cliSources()) {
      for (const m of f.text.matchAll(/buildGateEnvelope\(\s*'([^']+)'/g)) verbs.add(m[1]!);
    }
    expect(verbs.size).toBeGreaterThanOrEqual(8);
    for (const v of verbs) expect({ v, gate: isGateVerb(v) }).toEqual({ v, gate: true });
  });

  /**
   * THE settle-site ledger (round 11 review F4), two-way: every CLI file that
   * settles a verdict through `settleVerdict(` names the verdict verbs it
   * answers for — each a registered verdict verb, so its `2` survives a pipe and
   * a bad flag is `3` — or an explicit exemption with its reason. The
   * `buildGateEnvelope` lock above covers envelope emitters only; before this,
   * `self-config broken-links` settled 1/2 and nothing noticed it was
   * unregistered. A new settle site, or a row whose file stopped settling,
   * fails.
   */
  const SETTLE_SITES: Readonly<Record<string, readonly string[] | { readonly exempt: string }>> = {
    'commands/arch.command.ts': ['arch'],
    'commands/baseline.command.ts': ['baseline update'],
    'commands/check.command.ts': ['check', 'check imports'],
    'commands/checks.command.ts': ['checks doctor'],
    'commands/commands.command.ts': {
      exempt: '`commands doctor` maintains SharkCraft itself: gated (78) outside its repository, where no agent chains on it',
    },
    'commands/conventions.command.ts': ['conventions doctor', 'conventions check'],
    'commands/doctor.command.ts': ['doctor'],
    'commands/gates.command.ts': ['gates try', 'gates scaffold-selftest'],
    // `graph cycles` settles over the shared index-freshness record (R11-GAP-1).
    'commands/graph-code-subverbs.ts': ['graph cycles'],
    'commands/helper.command.ts': ['helper doctor'],
    'commands/impact.command.ts': {
      exempt: '`impact --deleted` is keyed by a FLAG, and the verdict registry keys on positional paths (KEYSTONE §25)',
    },
    'commands/packs-new.ts': ['packs test'],
    // Round 12 (ONE-CHANGE): `packs contributions` settles 0/1/2 over the
    // references its By-file report could not check.
    'commands/packs.command.ts': ['packs doctor', 'packs release-check', 'packs signature-status', 'packs contributions'],
    'commands/registrations.command.ts': ['registrations doctor'],
    'commands/registry.command.ts': ['registry'],
    'commands/scaffolds.command.ts': ['scaffolds doctor'],
    'commands/search.command.ts': ['search tuning doctor'],
    'commands/self-config.command.ts': ['self-config doctor', 'self-config broken-links', 'self-config report'],
    'commands/templates.command.ts': ['templates doctor'],
    'commands/test.command.ts': ['test agent', 'test context'],
    'commands/wiring.command.ts': ['wiring unprovided', 'wiring orphans', 'wiring chain'],
    'gates/gate-envelope.ts': { exempt: 'the gate-envelope builder itself — every caller is held by the buildGateEnvelope lock above' },
    'gates/incomplete-registry-inventory.ts': {
      exempt: 'a settlement helper of the `registry <name>` verbs (registered as `registry`)',
    },
    // (Round 13, P4: `gates/registration-graph-verdict.ts` settles through
    // `buildGateEnvelope` now, so it left this ledger.)
    'quality/run-quality.ts': ['quality'],
  };

  test('every settleVerdict call site answers for a registered verdict verb, or carries an exemption (two-way)', () => {
    const settling = new Set<string>();
    for (const f of cliSources()) {
      const code = blankZoneKinds(f.text, lexCodeZones(f.text), new Set(['comment'] as const)).content;
      if (/\bsettleVerdict\(/.test(code)) settling.add(f.rel.split('\\').join('/'));
    }
    expect(settling.size).toBeGreaterThanOrEqual(20);
    expect([...settling].sort()).toEqual(Object.keys(SETTLE_SITES).sort());
    for (const [file, row] of Object.entries(SETTLE_SITES)) {
      if ('exempt' in row) {
        expect({ file, reasoned: row.exempt.length > 20 }).toEqual({ file, reasoned: true });
        continue;
      }
      expect({ file, verbs: row.length > 0 }).toEqual({ file, verbs: true });
      for (const verb of row) expect({ file, verb, gate: isGateVerb(verb) }).toEqual({ file, verb, gate: true });
    }
  });

  /**
   * THE advertised-exit ledger (round 11 review R11-GAP-5): every handler (and
   * declared subverb) whose description or usage ADVERTISES an exit code
   * ("Exit 0 … 1 …", "exits 1 when …") is a registered verdict verb — or an
   * exemption with its reason. The settle-site ledger keys on `settleVerdict(`
   * call sites, so a verb that hand-returns its 1 / 2 was invisible to it:
   * `packs contributions` exited 1 with no trailer, and a bad flag on a verb
   * whose own `2` means "not verified" exited that same 2.
   */
  const ADVERTISED_EXEMPT: Readonly<Record<string, string>> = {
    'baseline diff': 'informational — it always exits 0 when it ran; `baseline check` is the verdict',
  };
  const EXIT_ADVERT = /\bexit(?:s)?\s+(?:code\s+)?[0-3]\b/i;

  test('every handler that advertises an exit code is a registered verdict verb, or exempt with a reason', () => {
    const advertised = new Set<string>();
    for (const { path, handler } of buildRegistry().listAll()) {
      const rows = [
        { p: path.join(' '), text: `${handler.description ?? ''} ${handler.usage ?? ''}` },
        ...(handler.subverbs ?? []).map((s) => ({
          p: [...path, s.name].join(' '),
          text: `${s.description ?? ''} ${s.usage ?? ''}`,
        })),
      ];
      for (const r of rows) if (EXIT_ADVERT.test(r.text)) advertised.add(r.p);
    }
    expect(advertised.size).toBeGreaterThanOrEqual(10);
    expect([...advertised].filter((p) => !isGateVerb(p)).sort()).toEqual(Object.keys(ADVERTISED_EXEMPT).sort());
    for (const [verb, why] of Object.entries(ADVERTISED_EXEMPT)) {
      expect({ verb, reasoned: why.length > 20 }).toEqual({ verb, reasoned: true });
    }
  });

  /**
   * THE not-verified return ledger (R11-GAP-5), two-way: every command file
   * that returns `ExitCode.NotVerified` names the verdict verbs it answers for
   * — each registered, so its `2` survives a pipe and is never the usage `2` —
   * or an exemption with its reason.
   */
  const NOT_VERIFIED_SITES: Readonly<Record<string, readonly string[] | { readonly exempt: string }>> = {
    'commands/baseline.command.ts': ['baseline check', 'baseline update'],
    'commands/boundaries.command.ts': ['boundaries suggest'],
    'commands/check.command.ts': ['check'],
    'commands/checks.command.ts': ['checks doctor', 'checks list'],
    'commands/conventions.command.ts': ['conventions doctor', 'conventions check'],
    'commands/diff-check.command.ts': ['diff-check'],
    'commands/docs-references.command.ts': ['docs references check'],
    'commands/finish.command.ts': ['finish'],
    'commands/gates.command.ts': ['gates check', 'gates coverage', 'gates try', 'gates scaffold-selftest'],
    'commands/generated.command.ts': ['generated check'],
    'commands/impact.command.ts': {
      exempt: '`impact --deleted` is keyed by a FLAG, and the verdict registry keys on positional paths (KEYSTONE §25; docs/exit-codes.md "Known gaps")',
    },
    'commands/knowledge.command.ts': ['knowledge stale-check', 'knowledge verify'],
    'commands/policy-lint.command.ts': ['policy-lint'],
    'commands/recommend.command.ts': ['recommend'],
    'commands/registry-lifecycle-run.ts': ['check registry-lifecycle', 'registry lifecycle'],
    'commands/reuse-coverage.command.ts': ['reuse coverage'],
    'commands/test.command.ts': ['test agent', 'test context'],
    'commands/wiring.command.ts': ['wiring unprovided', 'wiring orphans', 'wiring chain'],
  };

  test('every command file that returns ExitCode.NotVerified answers for a registered verdict verb, or is exempt (two-way)', () => {
    const sites = new Set<string>();
    for (const f of cliSources()) {
      const rel = f.rel.split('\\').join('/');
      if (!rel.startsWith('commands/')) continue;
      const code = blankZoneKinds(f.text, lexCodeZones(f.text), new Set(['comment'] as const)).content;
      if (/\bExitCode\.NotVerified\b/.test(code)) sites.add(rel);
    }
    expect([...sites].sort()).toEqual(Object.keys(NOT_VERIFIED_SITES).sort());
    for (const [file, row] of Object.entries(NOT_VERIFIED_SITES)) {
      if ('exempt' in row) {
        expect({ file, reasoned: row.exempt.length > 20 }).toEqual({ file, reasoned: true });
        continue;
      }
      for (const verb of row) expect({ file, verb, gate: isGateVerb(verb) }).toEqual({ file, verb, gate: true });
    }
  });

  test('every `envelope` row has a behavioural case below, and every case is an `envelope` row', () => {
    // A verb flipped to `envelope` without a partial + empty fixture would be
    // routed on paper only — the file-level grep lock this replaced passed a
    // verb whose text branch returned the raw engine verdict (policy-lint).
    const envelopeRows = Object.entries(MATRIX)
      .filter(([, kind]) => kind === 'envelope')
      .map(([verb]) => verb)
      .sort();
    expect([...new Set(BEHAVIOUR.map((c) => c.verb))].sort()).toEqual(envelopeRows);
  });

  test('--exit-trailer reaches every data-defined gate verb, quality and the corpus check', () => {
    for (const path of [
      'gates check',
      'gates coverage',
      'quality',
      'policy-lint',
      'baseline check',
      'generated check',
      'docs references check',
      'knowledge stale-check',
      'check registry-lifecycle',
      // Round 11 final integration + review (TQ-5): each was registered so its
      // refusal / not-verified `2` survives a pipe — locked here, not only by
      // the registry ≡ matrix mirror above.
      'baseline update',
      'check',
      'self-config broken-links',
      // Round 13 (lane A): the report writer settles the doctor verdict.
      'self-config report',
      'gates scaffold-selftest',
      // Round 11 review (R11-GAP-5 / -1 / -3): each exits a code an agent
      // chains on, and a bad flag on each is now 3 — never its own 2.
      'graph cycles',
      'boundaries suggest',
      'packs contributions',
      'self-config resolve',
      'checks list',
      'recommend',
      'drift',
      'architecture violations',
    ]) {
      let written = '';
      emitPipeExitSignal(path, 2, { piped: false, trailer: true, write: (s) => void (written += s) });
      expect({ path, written }).toEqual({ path, written: 'shrk-exit: 2\n' });
      expect({ path, usage: usageExitFor(path) }).toEqual({ path, usage: ExitCode.UsageError });
    }
  });

  test('on a real consumer, every envelope emitter exits with exactly gate.exit', async () => {
    const fixture = resolve(import.meta.dir, '../../../../examples/gate-matrix-consumer');
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-matrix-'));
    roots.push(root);
    cpSync(fixture, root, { recursive: true });
    const emitters: { label: string; h: typeof checkCommand; pos: string[]; flags: Record<string, string | boolean> }[] = [
      { label: 'check wiring', h: checkCommand, pos: ['wiring'], flags: {} },
      { label: 'gates check', h: gatesCheckCommand, pos: [], flags: { 'no-spawn': true } },
      { label: 'gates coverage', h: gatesCoverageCommand, pos: [], flags: {} },
      { label: 'policy-lint', h: policyLintCommand, pos: [], flags: {} },
      { label: 'baseline check', h: baselineCheckCommand, pos: [], flags: { id: 'handler-roster,adoption-ledger' } },
      { label: 'generated check', h: generatedCheckCommand, pos: [], flags: { 'headers-only': true } },
      { label: 'docs references check', h: docsReferencesCheckCommand, pos: [], flags: {} },
      { label: 'knowledge stale-check', h: knowledgeStaleCheckCommand, pos: [], flags: {} },
    ];
    for (const e of emitters) {
      const r = await run(e.h, args(root, e.pos, { ...e.flags, json: true }));
      const gate = JSON.parse(r.out).gate;
      expect({ verb: e.label, exit: gate.exit, verdict: typeof gate.verdict }).toEqual({
        verb: e.label,
        exit: r.code,
        verdict: 'string',
      });
      expect(Array.isArray(gate.shortfalls)).toBe(true);
      expect(gate.coverage).toBeDefined();
      for (const rule of gate.rules) expect(rule.coverage).toBeDefined();
    }
  });
});

// ── 7. the behavioural matrix ───────────────────────────────────────────────

/**
 * The lock that holds "settle first, render second" at the surface a consumer
 * reads — replacing a file-level grep for `verdictLine(`, which passed a verb
 * whose text branch still returned the raw engine verdict (policy-lint:
 * `return report.verdict === 'errors' ? 1 : 0`, text 0 next to --json 2).
 *
 * For every routed emitter, on a PARTIAL fixture (a rule in scope examined less
 * than it was asked to) and an EMPTY one (nothing in scope): the text exit, the
 * --json exit and `gate.exit` are one number — the not-verified 2 — and the
 * text prints `NOT VERIFIED` and no clean sentence.
 *
 * A lane that flips its MATRIX row to `envelope` adds its case here; the
 * matrix/behaviour lock in section 6 fails until it does.
 */
interface IBehaviourCase {
  /** The GATE_VERB_PATHS / MATRIX key this emitter answers for. */
  readonly verb: string;
  /** Distinguishes a second case for the same verb in the test name. */
  readonly label?: string;
  readonly h: { run(a: ParsedArgs): Promise<number> | number };
  readonly pos: readonly string[];
  readonly flags?: Readonly<Record<string, string | boolean>>;
  /** Something in scope was not examined. */
  readonly partial: () => string | Promise<string>;
  /** Nothing in scope at all. */
  readonly empty: () => string | Promise<string>;
}

/** A sentence ending in a check mark, or a `— accepted.` clean line. */
const CLEAN_SENTENCE = /\.\s*✓|— accepted\.\s*$/m;

const POLICY_PARTIAL =
  "policyRules: [ { id: 'warn-todo', surface: 'ts', files: ['src/**/*.ts'], pattern: 'TODO', message: 'no todo', severity: 'warning' }, " +
  "{ id: 'stale-rule', surface: 'ts', files: ['nowhere/**/*.ts'], pattern: 'XQZ', message: 'x', severity: 'warning', failOnEmpty: false } ]";
const BASELINE_PARTIAL =
  "baselines: [{ id: 'bl-ok', baseline: 'baselines/ok.json', compute: { kind: 'extractor', source: { files: ['src/*.ts'], extract: 'export-names' } }, direction: 'two-way' }, " +
  "{ id: 'bl-stale', severity: 'warning', baseline: 'baselines/e.json', compute: { kind: 'extractor', source: { files: ['nowhere/*.ts'], extract: 'export-names' } }, direction: 'two-way' }]";
const GENERATED_PARTIAL =
  "generatedArtifacts: [{ id: 'gen-a', generatedGlob: ['gen/*.ts'], regen: 'mkdir -p {TMP}/gen && cp gen/*.ts {TMP}/gen/', provenanceHeader: { mustMatch: 'GENERATED', withinLines: 5 } }, " +
  "{ id: 'gen-stale', generatedGlob: ['nowhere/*.ts'], regen: 'true {TMP}', severity: 'warning' }]";
/** Two clean register/remove pairs — the lifecycle rule has something to judge when it reads them. */
const LIFECYCLE_FILES: Record<string, string> = {
  'src/a.ts':
    'const m = new Map();\nexport function registerA(id, x) { m.set(id, x); }\nexport function removeA(id) { m.delete(id); }\n',
  'src/b.ts':
    'const m = new Map();\nexport function registerB(id, x) { m.set(id, x); }\nexport function removeB(id) { m.delete(id); }\n',
};
const DOCS_PARTIAL =
  "templateFiles: ['templates.ts'], docReferences: [" +
  "{ id: 'doc-ok', files: ['docs/**/*.md'], tokenPattern: '\\\\bgmc[.-][a-z0-9-]+\\\\b', resolvesAs: ['template'], requireContext: 'backtick', severity: 'warning' }, " +
  "{ id: 'doc-stale', files: ['nowhere/**/*.md'], tokenPattern: '\\\\bzz[.][a-z]+\\\\b', resolvesAs: ['template'], severity: 'warning' }]";

function commitAll(root: string): void {
  for (const a of [['add', '-A'], ['commit', '-q', '-m', 'r75']]) {
    spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], {
      cwd: root,
    });
  }
}

/** A committed repo with nothing deleted. */
function committedRepo(): string {
  const root = workspace('', { '.gitignore': '.sharkcraft/\n', 'src/a.ts': 'export const A = 1;\n' });
  spawnSync('git', ['init', '-q'], { cwd: root });
  commitAll(root);
  return root;
}

/** Indexed with src/a.ts; src/c.ts (imported by src/usec.ts) lands after the index; both a and c are deleted. */
async function partiallyIndexedDeletion(): Promise<string> {
  const root = workspace('', {
    '.gitignore': '.sharkcraft/\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' } }),
    'src/a.ts': 'export const A = 1;\n',
    'src/keep.ts': 'export const K = 1;\n',
  });
  spawnSync('git', ['init', '-q'], { cwd: root });
  commitAll(root);
  const { buildFullIndex } = await import('@shrkcrft/graph');
  buildFullIndex({ projectRoot: root });
  writeFileSync(join(root, 'src', 'c.ts'), 'export const C = 3;\n');
  writeFileSync(join(root, 'src', 'usec.ts'), "import { C } from './c';\nexport const X = C;\n");
  commitAll(root);
  rmSync(join(root, 'src', 'a.ts'));
  rmSync(join(root, 'src', 'c.ts'));
  return root;
}

/**
 * Indexed with src/a.ts; src/usea.ts (imports ./a) lands AFTER the index; a is
 * deleted. Every deleted file is known to the index — the IMPORTER side is
 * stale: the index never read usea.ts, so "no orphans" proves nothing.
 */
async function staleImporterDeletion(): Promise<string> {
  const root = workspace('', {
    '.gitignore': '.sharkcraft/\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' } }),
    'src/a.ts': 'export const A = 1;\n',
    'src/keep.ts': 'export const K = 1;\n',
  });
  spawnSync('git', ['init', '-q'], { cwd: root });
  commitAll(root);
  const { buildFullIndex } = await import('@shrkcrft/graph');
  buildFullIndex({ projectRoot: root });
  writeFileSync(join(root, 'src', 'usea.ts'), "import { A } from './a';\nexport const X = A;\n");
  commitAll(root);
  rmSync(join(root, 'src', 'a.ts'));
  return root;
}

/** One entry with a checkable file reference, one with none — the second is never checked. */
const KNOWLEDGE_PARTIAL_FILES: Record<string, string> = {
  'src/a.ts': 'export const A = 1;\n',
  'sharkcraft/knowledge.ts':
    'export default [\n' +
    "  { id: 'k.checked', title: 'Checked', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About A.', references: [{ kind: 'file', path: 'src/a.ts' }] },\n" +
    "  { id: 'k.unchecked', title: 'Unchecked', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'Declares nothing.' },\n" +
    '];\n',
};

const BEHAVIOUR: readonly IBehaviourCase[] = [
  {
    verb: 'check wiring',
    h: checkCommand,
    pos: ['wiring'],
    partial: () => workspace(subsetRule(), SUBSET_FILES),
    empty: () => workspace(''),
  },
  {
    verb: 'gates check',
    h: gatesCheckCommand,
    pos: [],
    partial: () => workspace(subsetRule(), SUBSET_FILES),
    empty: () => workspace(''),
  },
  {
    verb: 'gates coverage',
    h: gatesCoverageCommand,
    pos: [],
    partial: () => workspace(subsetRule(), SUBSET_FILES),
    empty: () => workspace(''),
  },
  {
    verb: 'policy-lint',
    h: policyLintCommand,
    pos: [],
    partial: () => workspace(POLICY_PARTIAL, { 'src/a.ts': 'export const TODO_A = 1;\n' }),
    empty: () => workspace(''),
  },
  {
    verb: 'baseline check',
    h: baselineCheckCommand,
    pos: [],
    partial: () =>
      workspace(BASELINE_PARTIAL, {
        'src/a.ts': 'export const A = 1;\n',
        'baselines/ok.json': '["A"]\n',
        'baselines/e.json': '[]\n',
      }),
    empty: () => workspace(''),
  },
  {
    verb: 'generated check',
    h: generatedCheckCommand,
    pos: [],
    flags: { 'headers-only': true },
    partial: () => workspace(GENERATED_PARTIAL, { 'gen/a.ts': '// GENERATED\nexport const X = 1;\n' }),
    empty: () => workspace(''),
  },
  {
    verb: 'docs references check',
    h: docsReferencesCheckCommand,
    pos: [],
    partial: () =>
      workspace(DOCS_PARTIAL, {
        'sharkcraft/templates.ts':
          "export default [{ id: 'gmc.handler', name: 'Handler', description: 'A handler construct.', files: [] }];\n",
        'docs/a.md': 'Use `gmc.handler` to add one.\n',
      }),
    empty: () => workspace(''),
  },
  {
    verb: 'check orphans',
    h: checkCommand,
    pos: ['orphans'],
    flags: { since: 'HEAD' },
    partial: partiallyIndexedDeletion,
    empty: committedRepo,
  },
  {
    verb: 'check orphans',
    label: 'check orphans (stale index)',
    h: checkCommand,
    pos: ['orphans'],
    flags: { since: 'HEAD' },
    partial: staleImporterDeletion,
    empty: committedRepo,
  },
  // Lifecycle: a file cap below the candidate count is a PARTIAL scope (the
  // sorted first candidate is the config file, so the paired src/ files are
  // never read); a repo with no register* declaration is EMPTY.
  {
    verb: 'check registry-lifecycle',
    h: checkCommand,
    pos: ['registry-lifecycle'],
    flags: { limit: '1' },
    partial: () => workspace('', LIFECYCLE_FILES),
    empty: () => workspace(''),
  },
  {
    verb: 'registry lifecycle',
    h: registryLifecycleCommand,
    pos: [],
    flags: { limit: '1' },
    partial: () => workspace('', LIFECYCLE_FILES),
    empty: () => workspace(''),
  },
  // Reuse coverage: one workspace package resolves, the other's entry names a
  // file that does not exist, so its exports were never measured (PARTIAL); an
  // indexed repo with no curated entry and no package is EMPTY.
  {
    verb: 'reuse coverage',
    h: reuseCoverageCommand,
    pos: [],
    partial: async () => {
      const root = workspace("reusePrimitives: [{ symbol: 'Alpha', roles: ['alpha'], importPath: '@fx/a' }]", {
        'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', private: true, workspaces: ['packages/*'] }),
        'packages/a/package.json': JSON.stringify({ name: '@fx/a', version: '0.0.0', main: 'src/index.ts' }),
        'packages/a/src/index.ts': 'export class Alpha {}\n',
        'packages/b/package.json': JSON.stringify({ name: '@fx/b', version: '0.0.0', main: 'dist/index.js' }),
        'packages/b/lib/b.ts': 'export const B = 1;\n',
      });
      const { buildFullIndex } = await import('@shrkcrft/graph');
      buildFullIndex({ projectRoot: root });
      return root;
    },
    empty: async () => {
      const root = workspace('');
      const { buildFullIndex } = await import('@shrkcrft/graph');
      buildFullIndex({ projectRoot: root });
      return root;
    },
  },
  // Knowledge stale-check / verify: one entry declares a checkable reference,
  // one declares none — the unverifiable entry was never checked (PARTIAL); a
  // configured repo with no entries at all is EMPTY.
  {
    verb: 'knowledge stale-check',
    h: knowledgeStaleCheckCommand,
    pos: [],
    partial: () => workspace("knowledgeFiles: ['knowledge.ts']", KNOWLEDGE_PARTIAL_FILES),
    empty: () => workspace(''),
  },
  {
    verb: 'knowledge verify',
    h: knowledgeVerifyCommand,
    pos: [],
    partial: () => workspace("knowledgeFiles: ['knowledge.ts']", KNOWLEDGE_PARTIAL_FILES),
    empty: () => workspace(''),
  },
  // Boundaries (round 11): a live rule next to a warning rule whose scope glob
  // matches nothing is PARTIAL; no rules loaded at all is EMPTY.
  {
    verb: 'check boundaries',
    h: checkCommand,
    pos: ['boundaries'],
    partial: () =>
      workspace("boundaryFiles: ['boundaries.ts']", {
        'sharkcraft/boundaries.ts': BOUNDARY_PARTIAL_RULES,
        'src/app/a.ts': 'export const a = 1;\n',
      }),
    empty: () => workspace(''),
  },
  // finish / diff-check: a changed file governed by a rule whose OTHER scope
  // glob is dead settles the boundaries sub-gate partial; nothing changed is
  // EMPTY.
  {
    verb: 'finish',
    h: finishCommand,
    pos: [],
    flags: { since: 'HEAD' },
    partial: governedChangeWithDeadGlob,
    empty: committedRepo,
  },
  {
    verb: 'diff-check',
    h: diffCheckCommand,
    pos: [],
    flags: { since: 'HEAD' },
    partial: governedChangeWithDeadGlob,
    empty: committedRepo,
  },
  // Round 13 (P4): an idiom whose DECLARED role matches no file (provided and
  // consumed live) is PARTIAL — the role authority's record is folded, so
  // "every token has a provider" is never a ✓ over it; no idiom is EMPTY.
  {
    verb: 'wiring unprovided',
    h: wiringCommand,
    pos: ['unprovided'],
    partial: () => workspace(DEAD_DECLARED_ROLE_IDIOM, DEAD_DECLARED_ROLE_FILES),
    empty: () => workspace(''),
  },
  {
    verb: 'wiring orphans',
    h: wiringCommand,
    pos: ['orphans'],
    partial: () => workspace(DEAD_DECLARED_ROLE_IDIOM, DEAD_DECLARED_ROLE_FILES),
    empty: () => workspace(''),
  },
  // Round 13 review: the chain folds the same role records — a live
  // provided→consumed chain over a dead declared role is PARTIAL (it printed
  // "✓ declared → provided → consumed."); no idiom is EMPTY.
  {
    verb: 'wiring chain',
    h: wiringCommand,
    pos: ['chain', 'A_TOKEN'],
    partial: () => workspace(DEAD_DECLARED_ROLE_IDIOM, DEAD_DECLARED_ROLE_FILES),
    empty: () => workspace(''),
  },
  // Round 13: a convention file that never loaded is PARTIAL (its conventions
  // were never checked); a project with no convention is EMPTY. `--files`
  // keeps the file scope non-empty in both, so each shape is the registry's.
  {
    verb: 'conventions check',
    h: conventionsCheckCommand,
    pos: [],
    flags: { files: 'src/a.ts' },
    partial: () => workspace("conventionFiles: ['missing.ts']", { 'src/a.ts': 'export const a = 1;\n' }),
    empty: () => workspace('', { 'src/a.ts': 'export const a = 1;\n' }),
  },
];

/** A registration idiom whose declared role names a file that does not exist; provided/consumed are live. */
const DEAD_DECLARED_ROLE_IDIOM =
  "registrationGraph: [ { name: 'di', " +
  "declared: { files: ['src/planned/tokens.ts'], pattern: 'export const ([A-Z_]+) = new InjectionToken' }, " +
  "provided: { files: ['src/module.ts'], pattern: 'provide[(]([A-Z_]+)' }, " +
  "consumed: { files: ['src/use.ts'], pattern: 'inject[(]([A-Z_]+)' } } ]";
const DEAD_DECLARED_ROLE_FILES: Record<string, string> = {
  'src/module.ts': 'provide(A_TOKEN);\n',
  'src/use.ts': 'inject(A_TOKEN);\n',
};

/** One live error rule + one warning rule whose scope matches no file (skipped, not failOnEmpty). */
const BOUNDARY_PARTIAL_RULES = `export default [
  { id: 'app-live', title: 'App live', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui'] },
  { id: 'app-stale', title: 'App stale', severity: 'warning', from: ['nowhere/**'], forbiddenImports: ['@scope/ui'] },
];
`;

/**
 * A committed repo whose boundary rule governs `src/app/**` and a dead
 * `src/gone/**`; `src/app/a.ts` is then modified. The changed file is governed,
 * so the rule is selected — and half its scope reached nothing.
 */
function governedChangeWithDeadGlob(): string {
  const root = workspace("boundaryFiles: ['boundaries.ts']", {
    '.gitignore': '.sharkcraft/\n',
    'sharkcraft/boundaries.ts': `export default [
  { id: 'app-fence', title: 'App fence', severity: 'error', from: ['src/app/**', 'src/gone/**'], forbiddenImports: ['@scope/ui'] },
];
`,
    'src/app/a.ts': 'export const a = 1;\n',
  });
  spawnSync('git', ['init', '-q'], { cwd: root });
  commitAll(root);
  writeFileSync(join(root, 'src', 'app', 'a.ts'), 'export const a = 2;\n');
  return root;
}

describe('the behavioural matrix — text exit == --json exit == gate.exit, and never a clean sentence', () => {
  for (const c of BEHAVIOUR) {
    for (const shape of ['partial', 'empty'] as const) {
      test(`${c.label ?? c.verb} — ${shape} scope`, async () => {
        const root = await c[shape]();
        const text = await run(c.h, args(root, [...c.pos], { ...(c.flags ?? {}) }));
        const json = await run(c.h, args(root, [...c.pos], { ...(c.flags ?? {}), json: true }));
        const gate = JSON.parse(json.out).gate;
        expect({ verb: c.verb, shape, text: text.code, json: json.code, gate: gate.exit }).toEqual({
          verb: c.verb,
          shape,
          text: ExitCode.NotVerified,
          json: ExitCode.NotVerified,
          gate: ExitCode.NotVerified,
        });
        expect({ verb: c.verb, shape, clean: CLEAN_SENTENCE.test(text.out) }).toEqual({
          verb: c.verb,
          shape,
          clean: false,
        });
        expect({ verb: c.verb, shape, notVerified: text.out.includes('NOT VERIFIED') }).toEqual({
          verb: c.verb,
          shape,
          notVerified: true,
        });
      }, 60_000);
    }
  }
});
