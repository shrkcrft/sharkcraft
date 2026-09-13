/**
 * Round 11, gate-planes review fixes. Each case is a defect the adversarial
 * review reproduced on a real fixture.
 *
 *   1. `gates scaffold-selftest` pinned a LIVE policy violation as an
 *      `expectIds` anchor. Paying the debt then turned `gates coverage` red.
 *      Only exempted hits (a fixture proving the pattern still bites) may be
 *      pinned now.
 *   2. `shrk quality`'s gates-coverage item read "coverage cannot inspect a
 *      `command` baseline" as "unverified". A healthy command baseline with no
 *      watchFiles was a permanent `2`, while the rule's own plane item, which
 *      spawned the command, said passed.
 *   3. `failOnEmpty` on a registration idiom meant two things. Coverage keyed
 *      "empty" on the declared role, check on the union of every role, so check
 *      printed ✓ over an idiom coverage FAILED. Both now read one per-role
 *      measurement.
 *   4. Dead globs were counted and failed inside rules that match nothing, and
 *      `--fail-on-dead-units` turned a soft-empty rule's `2` into a `1`.
 *   5. `gates try --flags` with no value was silently dropped.
 *
 * Real configs through the real handlers and a real inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type IQualityConfig } from '@shrkcrft/inspector';
import {
  gatesCheckCommand,
  gatesCoverageCommand,
  gatesScaffoldSelfTestCommand,
  gatesTryCommand,
  prepare,
} from '../commands/gates.command.ts';
import { runQuality } from '../quality/run-quality.ts';
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

/** A fresh workspace per config: a config module is never re-imported after an edit. */
function workspace(config: Record<string, unknown>, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-gpr-'));
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

async function quality(root: string) {
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

// ─── 1. scaffold-selftest never pins a live policy finding ──────────────────

/** `legacyCall('<id>')`, where capture group 1 is the id. */
const LEGACY = "legacyCall\\(['\"]([a-z]+)['\"]";

function legacyRule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'no-legacy',
    surface: 'ts',
    files: ['src/**/*.ts'],
    severity: 'warning',
    message: 'no legacyCall',
    pattern: LEGACY,
    ...extra,
  };
}

interface IScaffoldJson {
  readonly expectMatchesAtLeast: number;
  readonly expectIds: string[];
  readonly note?: string;
  readonly snippet: string;
}

async function scaffold(root: string): Promise<IScaffoldJson> {
  const r = await run(gatesScaffoldSelfTestCommand, args(root, ['no-legacy'], { json: true }));
  expect(r.code).toBe(ExitCode.VerifiedPass);
  return JSON.parse(r.out) as IScaffoldJson;
}

describe('review #1: scaffold-selftest pins only exempted policy hits', () => {
  const DEBT = "legacyCall('debt');\n";

  test('a live finding is never scaffolded, and paying the debt keeps coverage green', async () => {
    const rule = legacyRule({ exemptFiles: ['src/fixtures/**'] });
    const files = { 'src/a.ts': DEBT, 'src/fixtures/legacy.ts': "legacyCall('boom');\n" };
    const s = await scaffold(workspace({ policyRules: [rule] }, files));
    expect(s.expectIds).toEqual(['boom']);
    expect(s.note).toContain('live finding');
    expect(s.note).toContain('debt');

    // The block pasted verbatim, as the author would.
    const pasted = workspace(
      { policyRules: [{ ...rule, selfTest: { expectMatchesAtLeast: s.expectMatchesAtLeast, expectIds: s.expectIds, expectNotIds: [] } }] },
      files,
    );
    expect((await run(gatesCoverageCommand, args(pasted, []))).code).toBe(ExitCode.VerifiedPass);
    // The author fixes the code the rule forbids. The gate must stay green.
    writeFileSync(join(pasted, 'src/a.ts'), 'export const a = 1;\n');
    const after = await run(gatesCoverageCommand, args(pasted, [], { json: true }));
    expect(after.code).toBe(ExitCode.VerifiedPass);
    expect(JSON.parse(after.out).rules[0].status).toBe('ok');
  });

  test('with no exempted hit, expectIds is scaffolded EMPTY with a note, never the violation', async () => {
    const rule = legacyRule();
    const s = await scaffold(workspace({ policyRules: [rule] }, { 'src/a.ts': DEBT, 'src/b.ts': 'export const b = 1;\n' }));
    expect(s.expectIds).toEqual([]);
    expect(s.snippet).toContain('expectIds: [],');
    expect(s.note).toContain('exemptFiles');

    const pasted = workspace(
      { policyRules: [{ ...rule, selfTest: { expectMatchesAtLeast: s.expectMatchesAtLeast, expectIds: s.expectIds, expectNotIds: [] } }] },
      { 'src/a.ts': DEBT, 'src/b.ts': 'export const b = 1;\n' },
    );
    writeFileSync(join(pasted, 'src/a.ts'), 'export const a = 1;\n');
    expect((await run(gatesCoverageCommand, args(pasted, []))).code).toBe(ExitCode.VerifiedPass);
  });

  test('coverage JSON carries pinIds: exempted hits only, never a live finding', async () => {
    const root = workspace(
      { policyRules: [legacyRule({ exemptFiles: ['src/fixtures/**'] })] },
      { 'src/a.ts': DEBT, 'src/fixtures/legacy.ts': "legacyCall('boom');\n" },
    );
    const body = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    expect(body.rules[0].pinIds).toEqual(['boom']);
    expect(body.rules[0].sampleIds).toEqual(['boom', 'debt']);
  });
});

// ─── 2. quality settles an un-inspectable rule on its plane check ───────────

describe('review #2: a healthy `command` baseline with no watchFiles does not strand quality at 2', () => {
  const LEDGER = { 'sharkcraft/ledger.txt': 'a\n', 'src/a.ts': 'export const a = 1;\n' };
  const baseline = (extra: Record<string, unknown> = {}) => ({
    id: 'ledger',
    baseline: 'sharkcraft/ledger.txt',
    compute: { kind: 'command', run: 'echo a' },
    ...extra,
  });

  test('quality exits 0, and the gates-coverage item passes (not skipped)', async () => {
    const root = workspace({ baselines: [baseline()] }, LEDGER);
    const q = await quality(root);
    expect(q.items.find((i) => i.id === 'baseline:ledger')?.status).toBe('passed');
    const item = q.items.find((i) => i.id === 'gates-coverage');
    expect(item?.status).toBe('passed');
    expect(item?.notes.join('\n')).toContain('settled on its plane check');
    expect(q.shortfalls).toEqual([]);
    expect(q.exit).toBe(ExitCode.VerifiedPass);

    // The verb itself never spawns, so it still says it could not inspect the
    // rule. That is honest there, and the row says so structurally.
    const cov = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    expect(cov.rules[0].inspectable).toBe(false);
  });

  test('a selfTest it can never evaluate is still a misconfiguration: the item fails (1)', async () => {
    const root = workspace({ baselines: [baseline({ selfTest: { expectMatchesAtLeast: 1 } })] }, LEDGER);
    const q = await quality(root);
    expect(q.items.find((i) => i.id === 'gates-coverage')?.status).toBe('failed');
    expect(q.exit).toBe(ExitCode.Failure);
  });
});

// ─── 3. one authority for "is this registration idiom empty?" ──────────────

const REG_FILES: Record<string, string> = {
  'src/tokens/foo.ts': 'export const FOO = Symbol();\nexport const BAR = Symbol();\n',
  'src/empty/none.ts': '// no exports here\nconst x = 1;\n',
  'src/providers.ts': 'provide(FOO);\nprovide(BAR);\n',
  'src/consumers.ts': 'inject(FOO);\ninject(BAR);\n',
};

function idiom(over: { declared?: string; provided?: string; consumed?: string }, failOnEmpty: boolean) {
  return {
    name: 'di',
    ...(failOnEmpty ? { failOnEmpty: true } : {}),
    declared: { files: [over.declared ?? 'src/tokens/*.ts'], extract: 'export-names' },
    provided: { files: [over.provided ?? 'src/providers.ts'], extract: 'regex-capture', pattern: 'provide\\((\\w+)\\)' },
    consumed: { files: [over.consumed ?? 'src/consumers.ts'], extract: 'regex-capture', pattern: 'inject\\((\\w+)\\)' },
  };
}

/** Each shape with the exit BOTH verbs must give, without and with failOnEmpty. */
const SHAPES: readonly { label: string; over: Parameters<typeof idiom>[0]; soft: number; hard: number; empty: boolean }[] = [
  { label: 'every role live', over: {}, soft: 0, hard: 0, empty: false },
  { label: 'declared glob moved (0 files)', over: { declared: 'src/tokens-moved/*.ts' }, soft: 2, hard: 1, empty: true },
  { label: 'declared reads files but extracts 0 tokens', over: { declared: 'src/empty/*.ts' }, soft: 2, hard: 1, empty: true },
  // Every declared/consumed token then reads "unprovided". That verdict comes
  // from a stale input, so it is NOT VERIFIED (2), never a warning-only 0.
  { label: 'provided glob moved (0 files)', over: { provided: 'src/providers-moved.ts' }, soft: 2, hard: 2, empty: false },
  { label: 'consumed glob moved (0 files)', over: { consumed: 'src/consumers-moved.ts' }, soft: 2, hard: 2, empty: false },
  // A provided role over LIVE files extracting nothing is the finding itself
  // (unprovided tokens, warning severity), not an unexamined role.
  { label: 'provided reads files but provides nothing', over: { provided: 'src/consumers.ts' }, soft: 0, hard: 0, empty: false },
  {
    label: 'every role moved',
    over: { declared: 'gone/*.ts', provided: 'gone/p.ts', consumed: 'gone/c.ts' },
    soft: 2,
    hard: 1,
    empty: true,
  },
];

describe('review #3: gates check and gates coverage read ONE registration measurement', () => {
  test('PROPERTY: for every shape, with and without failOnEmpty, check ≡ coverage (exit and empty)', async () => {
    for (const shape of SHAPES) {
      for (const failOnEmpty of [false, true]) {
        const label = `${shape.label} (failOnEmpty=${failOnEmpty})`;
        const root = workspace({ registrationGraph: [idiom(shape.over, failOnEmpty)] }, REG_FILES);
        const checkText = await run(gatesCheckCommand, args(root, []));
        const checkJson = JSON.parse((await run(gatesCheckCommand, args(root, [], { json: true }))).out);
        const covText = await run(gatesCoverageCommand, args(root, []));
        const covJson = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
        const want = failOnEmpty ? shape.hard : shape.soft;
        const checkRule = checkJson.gate.rules[0];
        expect({
          label,
          checkText: checkText.code,
          checkJson: checkJson.exitCode,
          covText: covText.code,
          covJson: covJson.exitCode,
        }).toEqual({ label, checkText: want, checkJson: want, covText: want, covJson: want });
        // "Empty" means the same thing to both verbs.
        const checkEmpty = checkRule.skipReason !== undefined;
        expect({ label, checkEmpty, covEmpty: covJson.rules[0].status === 'empty' }).toEqual({
          label,
          checkEmpty: shape.empty,
          covEmpty: shape.empty,
        });
        // Both verbs carry the one roles record.
        expect({ label, same: checkRule.coverage }).toEqual({ label, same: covJson.rules[0].coverage });
        // Never a ✓ over a role that examined nothing.
        if (want !== ExitCode.VerifiedPass) {
          expect({ label, tick: /✓ \[registration\]/.test(checkText.out) }).toEqual({ label, tick: false });
        }
      }
    }
  });

  test('the reviewer’s fixture: a failOnEmpty idiom whose declared glob moved FAILS check, with the reason', async () => {
    const root = workspace({ registrationGraph: [idiom({ declared: 'src/tokens-moved/*.ts' }, true)] }, REG_FILES);
    const { code, out } = await run(gatesCheckCommand, args(root, []));
    expect(code).toBe(ExitCode.Failure);
    expect(out).toContain('FAILED — the declared role extracted 0 tokens (failOnEmpty)');
    expect(out).toContain('declared (0 files)');
    expect(out).not.toContain('Every declared rule ran and passed');
  });
});

// ─── 4. dead globs belong to CONNECTED rules only ───────────────────────────

describe('review #4 (low): an empty rule keeps its own verdict; its dead globs are not a second finding', () => {
  const STALE = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    source: { files: ['src/old-tools/*.ts'], extract: 'export-names' },
    ...extra,
  });
  const FILES = { 'src/tools/a.ts': 'export const alpha = 1;\n' };

  test('no dead-glob count or ⚠ line for rules that match nothing', async () => {
    const root = workspace({ registries: [STALE('tools-stale', { failOnEmpty: true }), STALE('tools-soft')] }, FILES);
    const body = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    expect(body.deadGlobCount).toBe(0);
    const text = await run(gatesCoverageCommand, args(root, []));
    expect(text.out).not.toContain('⚠');
    expect(text.out).not.toContain('dead globs');
  });

  test('--fail-on-dead-units never turns a soft-empty rule’s 2 into a 1', async () => {
    const root = workspace({ registries: [STALE('tools-soft')] }, FILES);
    const plain = await run(gatesCoverageCommand, args(root, [], { only: 'tools-soft' }));
    const flagged = await run(gatesCoverageCommand, args(root, [], { only: 'tools-soft', 'fail-on-dead-units': true }));
    expect(plain.code).toBe(ExitCode.NotVerified);
    expect(flagged.code).toBe(ExitCode.NotVerified);
    const json = JSON.parse(
      (await run(gatesCoverageCommand, args(root, [], { only: 'tools-soft', 'fail-on-dead-units': true, json: true }))).out,
    );
    expect(json.gate.rules[0].status).toBe('skipped');
    expect(json.gate.rules[0].violations).toEqual([]);
  });

  test('the quality item adds no advisory dead-glob note for an empty rule', async () => {
    const root = workspace({ registries: [STALE('tools-soft')] }, FILES);
    const item = (await quality(root)).items.find((i) => i.id === 'gates-coverage');
    expect(item?.notes.join('\n')).not.toContain('advisory');
  });
});

// ─── 5. `gates try --flags` needs a value ───────────────────────────────────

describe('review #5 (low): `gates try --flags` with no value is refused, never dropped', () => {
  const SPEC = 'declared=src/tools/*.tool.ts:^export const (\\w+Tool)\\b registered=src/all.ts:\\b(\\w+Tool)\\b';
  const FILES = {
    'src/tools/a.tool.ts': 'export const aTool = 1;\n',
    'src/all.ts': 'export const ALL = [aTool];\n',
  };

  test('--flags (bare) and --flags "" both exit 3 with the remedy', async () => {
    const root = workspace({}, FILES);
    for (const value of [true, ''] as const) {
      const r = await run(gatesTryCommand, args(root, [], { wiring: SPEC, flags: value }));
      expect({ value, code: r.code }).toEqual({ value, code: ExitCode.UsageError });
      expect(r.out).toContain('--flags needs a value, e.g. --flags m');
    }
    // With a value it runs, and the anchored pattern matches per line.
    const ok = await run(gatesTryCommand, args(root, [], { wiring: SPEC, flags: 'm' }));
    expect(ok.code).toBe(ExitCode.VerifiedPass);
  });
});
