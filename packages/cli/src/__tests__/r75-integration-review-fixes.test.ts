/**
 * Round 11 (integration lane) — the adversarial review's defects, locked at the
 * surface a consumer reads (exit code, --json, the printed line).
 *
 *   D1  `generated check` over a regen output larger than the regen read cap:
 *       one keyed onto nothing committed is drift its path proves (1), one
 *       keyed onto a committed file is uncomparable (PARTIAL, 2); never ✓.
 *   D2  MCP `get_wiring_graph` and D6 `wiring unprovided | orphans` + finish:
 *       ONE helper settles an absence claim over an unread idiom file — the
 *       token is `unproven`, never a finding and never a pass.
 *   D3  `shrk check`, MCP `inspect_sharkcraft_setup` and the dashboard read
 *       THE doctor settlement: an unrecorded compiled pack build is never ready.
 *   D5  `check wiring --fix` reads the tree the check walked.
 *   D7  an `exemptFiles` file over the cap is narrowing, not a gap.
 *   D8  `baseline update` never blesses a ledger computed from an incomplete read.
 *   D9  `gates scaffold-selftest` never scaffolds from an incomplete read.
 *   D11 `trace literal` never says "No occurrences" over a file it never read.
 *   D12 per-rule lines render the SETTLED status: `~ PARTIAL`, never ✓.
 *   D13 `gates try` labels the read count honestly and names a gap once.
 *
 * Every fixture is a real mkdtemp workspace through the real config loader and
 * the real engines, with real files over the real caps on disk.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_REGEN_FILE_BYTES, MAX_SCAN_FILE_BYTES } from '@shrkcrft/boundaries';
import { buildDashboardDoctor, inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import type { ParsedArgs } from '../command-registry.ts';
import { baselineCheckCommand, baselineUpdateCommand } from '../commands/baseline.command.ts';
import { checkCommand } from '../commands/check.command.ts';
import { docsReferencesCheckCommand } from '../commands/docs-references.command.ts';
import { doctorCommand } from '../commands/doctor.command.ts';
import { gatesCheckCommand, gatesScaffoldSelfTestCommand, gatesTryCommand } from '../commands/gates.command.ts';
import { generatedCheckCommand, generatedUpdateCommand } from '../commands/generated.command.ts';
import { policyLintCommand } from '../commands/policy-lint.command.ts';
import { traceCommand } from '../commands/trace.command.ts';
import { wiringCommand } from '../commands/wiring.command.ts';
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

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function workspace(planes: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-review-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  write(root, 'sharkcraft/sharkcraft.config.ts', `export default { projectName: 'fx', ${planes} };\n`);
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

const WIRING =
  "{ id: 'tokens-wired', severity: 'warning', declared: { files: ['src/**/*.ts'], extract: 'export-names', match: '_T$' }, " +
  "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'T' } }";

const CLEAN_LINE = /\.\s*✓|— accepted\.\s*$/m;

function tool(name: string): (typeof ALL_TOOLS)[number] {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no MCP tool ${name}`);
  return t;
}

async function mcp(name: string, root: string): Promise<Record<string, unknown>> {
  const inspection = await inspectSharkcraft({ cwd: root });
  return (await tool(name).handler({}, { inspection, cwd: root })).data as Record<string, unknown>;
}

// ── D1. generated check over the regen read cap ─────────────────────────────

const GEN = "generatedArtifacts: [ { id: 'gen', generatedGlob: ['gen/**'], regen: 'sh regen.sh {TMP}' } ]";

/** Committed gen/a.txt, a regen.sh running `script`, and a payload over the regen cap outside the glob. */
function regenWorkspace(script: string): string {
  return workspace(GEN, {
    'gen/a.txt': 'A\n',
    'fixtures/big.txt': 'x'.repeat(MAX_REGEN_FILE_BYTES + 100_000),
    'regen.sh': `set -e\nmkdir -p "$1/gen"\n${script}\n`,
  });
}

describe('D1 — generated check never reads ✓ over a regen output it did not read', () => {
  test('a NEW over-cap regen output is drift its path proves (1), exactly like a small one — never ✓ / 0', async () => {
    const big = regenWorkspace('cp gen/a.txt "$1/gen/a.txt"\ncp fixtures/big.txt "$1/gen/new.txt"');
    const text = await run(generatedCheckCommand, args(big, []));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('gen/new.txt');
    expect(text.out).toContain('regen produces it but it is not committed');
    expect(text.out).not.toMatch(CLEAN_LINE);
    const json = JSON.parse((await run(generatedCheckCommand, args(big, [], { json: true }))).out);
    expect(json.exitCode).toBe(ExitCode.Failure);
    expect(json.results[0].differences).toContainEqual({ file: 'gen/new.txt', kind: 'only-regenerated' });

    // Control: the same new file at a few bytes is the same finding.
    const small = regenWorkspace('cp gen/a.txt "$1/gen/a.txt"\nprintf "small\\n" > "$1/gen/new.txt"');
    const control = JSON.parse((await run(generatedCheckCommand, args(small, [], { json: true }))).out);
    expect(control.exitCode).toBe(json.exitCode);
    expect(control.results[0].differences).toEqual(json.results[0].differences);
  }, SLOW);

  test('an over-cap regen output keyed onto a committed file is uncomparable: PARTIAL (2), named, text ≡ --json', async () => {
    const root = regenWorkspace('cp fixtures/big.txt "$1/gen/a.txt"');
    const text = await run(generatedCheckCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('gen/a.txt');
    expect(text.out).toContain('over the 2MB regen read cap');
    expect(text.out).toMatch(/^ {2}~ gen {2}PARTIAL — /m);
    expect(text.out).not.toMatch(/✓ gen/);
    const json = JSON.parse((await run(generatedCheckCommand, args(root, [], { json: true }))).out);
    expect({ exit: json.exitCode, status: json.gate.rules[0].status }).toEqual({ exit: 2, status: 'partial' });
  }, SLOW);

  test('generated update never writes an output it did not read, and says the bless is incomplete (1)', async () => {
    const root = regenWorkspace('cp gen/a.txt "$1/gen/a.txt"\ncp fixtures/big.txt "$1/gen/new.txt"');
    const r = await run(generatedUpdateCommand, args(root, []));
    expect(r.code).toBe(ExitCode.Failure);
    expect(r.out).toContain('not written: gen/new.txt');
    expect(existsSync(join(root, 'gen', 'new.txt'))).toBe(false);
  }, SLOW);
});

// ── D2 / D6. registration absence claims over an unread idiom file ──────────

const IDIOMS =
  "registrationGraph: [ { name: 'di', " +
  "declared: { files: ['src/**/*.ts'], pattern: 'export const ([A-Z_]+) = new InjectionToken' }, " +
  "provided: { files: ['src/prov*.ts'], pattern: 'provide[(]([A-Z_]+)' }, " +
  "consumed: { files: ['src/use*.ts'], pattern: 'inject[(]([A-Z_]+)' } } ]";
const TOKENS: Record<string, string> = {
  '.gitignore': '.sharkcraft/\n',
  'src/tokens.ts': "export const A_TOKEN = new InjectionToken('a');\n",
};

describe('D2 + D6 — an absence an unread file could refute is NOT VERIFIED in the verb, finish and MCP', () => {
  test('wiring unprovided: the only provider sits in an over-cap file → 2 (not the failure 1); MCP and finish agree', async () => {
    const root = committed(
      workspace(IDIOMS, {
        ...TOKENS,
        'src/use.ts': 'inject(A_TOKEN);\n',
        'src/prov-big.ts': overCap('provide(A_TOKEN);'),
      }),
    );
    const text = await run(wiringCommand, args(root, ['unprovided']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('A_TOKEN');
    expect(text.out).toContain('src/prov-big.ts');
    expect(text.out).not.toMatch(/✗ A_TOKEN/);
    const json = JSON.parse((await run(wiringCommand, args(root, ['unprovided'], { json: true }))).out);
    expect({ exit: json.exitCode, total: json.total, unproven: json.unproven.map((u: { token: string }) => u.token) }).toEqual({
      exit: 2,
      total: 0,
      unproven: ['A_TOKEN'],
    });

    const data = await mcp('get_wiring_graph', root);
    expect({ verdict: data['verdict'], unprovidedCount: data['unprovidedCount'] }).toEqual({
      verdict: 'not-verified',
      unprovidedCount: 0,
    });

    // finish, over a change to the consumer: the sub-gate is partial, never fail.
    writeFileSync(join(root, 'src', 'use.ts'), 'inject(A_TOKEN); // edited\n');
    const report = await runFinishGates({ cwd: root, mode: 'worktree', scope: { projectRoot: root, includeWorktree: true } });
    const unprovided = report.gates.find((g) => g.name === 'unprovided');
    expect(unprovided?.status).toBe('partial');
    expect(unprovided?.shortfall).toContain('A_TOKEN');
  }, SLOW);

  test('a real unprovided token next to an unrelated unread file still FAILS (1), with the gap named; MCP says fail', async () => {
    const root = workspace(IDIOMS, {
      ...TOKENS,
      'src/prov.ts': 'provide(A_TOKEN);\n',
      'src/use.ts': 'inject(A_TOKEN);\ninject(B_TOKEN);\n',
      'src/use-big.ts': overCap('inject(C_TOKEN);'),
    });
    const text = await run(wiringCommand, args(root, ['unprovided']));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toMatch(/✗ B_TOKEN/);
    expect(text.out).toContain('(also not verified');
    expect(text.out).toContain('src/use-big.ts');
    const data = await mcp('get_wiring_graph', root);
    expect({ verdict: data['verdict'], unprovidedCount: data['unprovidedCount'] }).toEqual({
      verdict: 'fail',
      unprovidedCount: 1,
    });
  }, SLOW);

  test('wiring orphans: a provider whose only consumer is in an over-cap file is 2, and never listed as an orphan', async () => {
    const root = workspace(IDIOMS, {
      ...TOKENS,
      'src/prov.ts': 'provide(A_TOKEN);\n',
      'src/use-big.ts': overCap('inject(A_TOKEN);'),
    });
    const text = await run(wiringCommand, args(root, ['orphans']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toMatch(/\? A_TOKEN/);
    expect(text.out).not.toMatch(/• A_TOKEN/);
    const json = JSON.parse((await run(wiringCommand, args(root, ['orphans'], { json: true }))).out);
    expect({ exit: json.exitCode, total: json.total }).toEqual({ exit: 2, total: 0 });
  }, SLOW);
});

// ── D3. one doctor settlement ───────────────────────────────────────────────

const ruleEntry = (summary: string): string =>
  `export default [{ id: 'distpack.rule', title: 'Rule', type: 'rule', priority: 'high', summary: '${summary}', content: '${summary} content', tags: [], scope: [], appliesWhen: [] }];\n`;

/** A pack serving dist/assets/rules.js built from src/assets/rules.ts; `record` is its build record. */
function compiledPack(record: 'none' | 'fresh-map'): string {
  const src = ruleEntry('NEW source');
  const pack = 'node_modules/@r11/distpack';
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-review-pack-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'r75-lane', version: '0.0.0', type: 'module', private: true }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'r75-lane' };\n",
    [`${pack}/package.json`]: JSON.stringify({
      name: '@r11/distpack',
      version: '0.0.1',
      type: 'module',
      sharkcraft: { manifest: './dist/sharkcraft.plugin.js' },
    }),
    [`${pack}/dist/sharkcraft.plugin.js`]:
      "export default { schema: 'sharkcraft.pack/v1', info: { name: '@r11/distpack', version: '0.0.1' }, contributions: { ruleFiles: ['./dist/assets/rules.js'] } };\n",
    [`${pack}/dist/assets/rules.js`]: record === 'fresh-map' ? src : ruleEntry('OLD compiled'),
    [`${pack}/src/assets/rules.ts`]: src,
    ...(record === 'fresh-map'
      ? {
          [`${pack}/dist/assets/rules.js.map`]: JSON.stringify({
            version: 3,
            sources: ['../../src/assets/rules.ts'],
            sourcesContent: [src],
            mappings: '',
          }),
        }
      : {}),
  };
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

describe('D3 — doctor ≡ check ≡ MCP ≡ dashboard over an unrecorded compiled pack build', () => {
  test('every surface reads not-verified; none reads ready / OK', async () => {
    const root = compiledPack('none');
    const doctor = await run(doctorCommand, args(root, []));
    expect(doctor.code).toBe(ExitCode.NotVerified);

    const check = await run(checkCommand, args(root, []));
    expect(check.code).toBe(ExitCode.NotVerified);
    expect(check.out).toMatch(/^ {2}PART {2}doctor\s/m);
    expect(check.out).toContain('NOT VERIFIED');
    const checkJson = JSON.parse((await run(checkCommand, args(root, [], { json: true }))).out);
    expect({ exit: checkJson.exitCode, verdict: checkJson.verdict }).toEqual({ exit: 2, verdict: 'not-verified' });
    expect(checkJson.groups.find((g: { name: string }) => g.name === 'doctor').notVerified).toBe(true);

    const setup = await mcp('inspect_sharkcraft_setup', root);
    expect({ verdict: setup['verdict'], ready: setup['ready'] }).toEqual({ verdict: 'not-verified', ready: false });
    expect(String((setup['shortfalls'] as string[])[0])).toContain('compiled pack builds');

    const dashboard = buildDashboardDoctor(await inspectSharkcraft({ cwd: root }));
    expect(dashboard.verdict).toBe('not-verified');
  }, SLOW);

  test('control: a compiled pack whose build record matches its source is not "not-verified" anywhere', async () => {
    const root = compiledPack('fresh-map');
    const check = await run(checkCommand, args(root, []));
    expect(check.code).not.toBe(ExitCode.NotVerified);
    const setup = await mcp('inspect_sharkcraft_setup', root);
    expect(setup['verdict']).not.toBe('not-verified');
    expect(buildDashboardDoctor(await inspectSharkcraft({ cwd: root })).verdict).not.toBe('not-verified');
  }, SLOW);
});

// ── D5. check wiring --fix reads the tree the check walked ──────────────────

describe('D5 — check wiring --fix sees the sink files the check saw', () => {
  test('a sink-shaped file in the SharkCraft dir no longer makes a fixable token ambiguous', async () => {
    const root = workspace(
      "wiringRules: [ { id: 'reg-wired', declared: { files: ['src/a.ts'], extract: 'export-names', match: '_T$' }, " +
        "registered: { files: ['**/reg.ts'], extract: 'array-members', anchor: 'T' } } ]",
      {
        'src/a.ts': 'export const A_T = 1;\nexport const B_T = 2;\n',
        'src/reg.ts': 'export const T = [A_T];\n',
        'sharkcraft/reg.ts': 'export const T = [];\n',
      },
    );
    const check = await run(checkCommand, args(root, ['wiring']));
    expect(check.code).toBe(ExitCode.Failure);
    expect(check.out).toContain('B_T');
    const fix = await run(checkCommand, args(root, ['wiring'], { fix: true }));
    expect(fix.out).not.toContain('ambiguous-sink-file');
    expect(fix.out).toContain('B_T');
    expect(fix.out).toContain('src/reg.ts');
    expect(fix.code).toBe(ExitCode.VerifiedPass);
  }, SLOW);
});

// ── D7. an exempt over-cap file is narrowing ────────────────────────────────

const exemptRule = (exempt: boolean): string =>
  `policyRules: [ { id: 'no-forbidden', surface: 'ts', files: ['src/**/*.ts'], ${exempt ? "exemptFiles: ['src/big.ts'], " : ''}` +
  "pattern: 'FORBIDDEN_TOKEN', message: 'no', severity: 'error' } ]";

describe('D7 — a policy exemption naming an over-cap file is narrowing, not a gap', () => {
  test('exempt → 0 in policy-lint and gates check; the same file not exempt → 2', async () => {
    const exempt = workspace(exemptRule(true), FILES);
    const text = await run(policyLintCommand, args(exempt, []));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).not.toContain('NOT VERIFIED');
    const json = JSON.parse((await run(policyLintCommand, args(exempt, [], { json: true }))).out);
    expect({ exit: json.exitCode, status: json.gate.rules[0].status }).toEqual({ exit: 0, status: 'passed' });
    const gates = JSON.parse((await run(gatesCheckCommand, args(exempt, [], { json: true }))).out);
    expect(gates.gate.exit).toBe(ExitCode.VerifiedPass);

    const plain = workspace(exemptRule(false), FILES);
    expect((await run(policyLintCommand, args(plain, []))).code).toBe(ExitCode.NotVerified);
  }, SLOW);
});

// ── D8. baseline update never blesses an incomplete read ────────────────────

describe('D8 — baseline update refuses a ledger computed from an incomplete read', () => {
  test('2, NOT VERIFIED naming the file, and the committed ledger is untouched (text and --json)', async () => {
    const root = workspace(
      "baselines: [ { id: 'exports-ledger', baseline: 'exports.json', compute: { kind: 'extractor', source: { files: ['src/**/*.ts'], extract: 'export-names' } } } ]",
      { ...FILES, 'exports.json': '["OLD"]\n' },
    );
    const text = await run(baselineUpdateCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('src/big.ts');
    expect(readFileSync(join(root, 'exports.json'), 'utf8')).toBe('["OLD"]\n');
    const json = JSON.parse((await run(baselineUpdateCommand, args(root, [], { json: true }))).out);
    expect({ exit: json.exitCode, unverified: json.unverified.map((u: { id: string }) => u.id), written: json.written }).toEqual({
      exit: 2,
      unverified: ['exports-ledger'],
      written: [],
    });
    expect(readFileSync(join(root, 'exports.json'), 'utf8')).toBe('["OLD"]\n');
  }, SLOW);
});

// ── D9. scaffold-selftest never scaffolds from an incomplete read ───────────

describe('D9 — gates scaffold-selftest refuses a count read off an incomplete scan', () => {
  test('2, the shortfall printed, no snippet, and --write never touches the config', async () => {
    const root = workspace(`wiringRules: [ ${WIRING} ]`, FILES);
    const configPath = join(root, 'sharkcraft', 'sharkcraft.config.ts');
    const before = readFileSync(configPath, 'utf8');
    const text = await run(gatesScaffoldSelfTestCommand, args(root, ['tokens-wired']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('src/big.ts');
    expect(text.out).not.toContain('selfTest: {');
    const written = await run(gatesScaffoldSelfTestCommand, args(root, ['tokens-wired'], { write: true }));
    expect(written.code).toBe(ExitCode.NotVerified);
    expect(written.out).toContain('--write refused');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    const json = JSON.parse((await run(gatesScaffoldSelfTestCommand, args(root, ['tokens-wired'], { json: true }))).out);
    expect(json.exitCode).toBe(ExitCode.NotVerified);
    expect(json.expectIds).toBeUndefined();
  }, SLOW);
});

// ── D11. trace literal over an unread file ──────────────────────────────────

describe('D11 — trace literal never claims "no occurrences" over a file it did not read', () => {
  test('the unread file is named and the zero is not verified', async () => {
    const root = workspace('', {
      'src/clean.ts': 'export const X = 1;\n',
      'src/big.ts': overCap("export const ROUTE = 'my-route-literal';"),
    });
    const text = await run(traceCommand, args(root, ['literal', 'my-route-literal']));
    expect(text.out).toContain('Not verified');
    expect(text.out).toContain('src/big.ts');
    expect(text.out).toContain('over the 1MB read cap');
    expect(text.out).not.toContain('No occurrences');
  }, SLOW);
});

// ── D12. per-rule lines render the settled status ───────────────────────────

describe('D12 — a partial rule reads "~ PARTIAL", never ✓, on its per-rule line', () => {
  test('generated check / baseline check / docs references check', async () => {
    const gen = workspace(
      "generatedArtifacts: [ { id: 'gen', generatedGlob: ['gen/**'], provenanceHeader: { mustMatch: 'GENERATED' } } ]",
      { 'gen/a.txt': 'GENERATED\nbody\n', 'gen/big.txt': overCap('GENERATED') },
    );
    const genOut = (await run(generatedCheckCommand, args(gen, []))).out;
    expect(genOut).toMatch(/^ {2}~ gen {2}PARTIAL — /m);
    expect(genOut).not.toMatch(/✓ gen/);

    const baseline = workspace(
      "baselines: [ { id: 'exports-ledger', baseline: 'exports.json', compute: { kind: 'extractor', source: { files: ['src/**/*.ts'], extract: 'export-names' } } } ]",
      { ...FILES, 'exports.json': `${JSON.stringify(['CLEAN_T', 'T'], null, 2)}\n` },
    );
    const baselineOut = (await run(baselineCheckCommand, args(baseline, []))).out;
    expect(baselineOut).toMatch(/^ {2}~ exports-ledger {2}PARTIAL — /m);
    expect(baselineOut).not.toMatch(/✓ exports-ledger/);

    const docs = workspace(
      "templateFiles: ['templates.ts'], docReferences: [" +
        "{ id: 'doc-ok', files: ['docs/**/*.md'], tokenPattern: '\\\\bgmc[.-][a-z0-9-]+\\\\b', resolvesAs: ['template'], requireContext: 'backtick', severity: 'warning' } ]",
      {
        'sharkcraft/templates.ts':
          "export default [{ id: 'gmc.handler', name: 'Handler', description: 'A handler construct.', files: [] }];\n",
        'docs/a.md': 'Use `gmc.handler` to add one.\n',
        'docs/big.md': overCap('Use `gmc.handler` here too.'),
      },
    );
    const docsText = await run(docsReferencesCheckCommand, args(docs, []));
    expect(docsText.code).toBe(ExitCode.NotVerified);
    expect(docsText.out).toMatch(/^ {2}~ doc-ok {2}PARTIAL — /m);
    expect(docsText.out).not.toMatch(/✓ doc-ok/);
  }, SLOW);
});

// ── D13. gates try ──────────────────────────────────────────────────────────

describe('D13 — gates try labels the read count and names one gap once', () => {
  test('"files read", and the NOT VERIFIED line names the unread file exactly once', async () => {
    const root = workspace('', FILES);
    const ruleFile = join(root, 'prule.json');
    writeFileSync(
      ruleFile,
      JSON.stringify({ id: 'cand', surface: 'ts', files: ['src/**/*.ts'], pattern: 'FORBIDDEN_TOKEN', message: 'm', severity: 'warning' }),
    );
    const text = await run(gatesTryCommand, args(root, [], { 'rule-file': ruleFile, plane: 'policy' }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('files read');
    expect(text.out).not.toContain('files matched');
    const line = text.out.split('\n').find((l) => l.includes('NOT VERIFIED')) ?? '';
    expect(line.split('src/big.ts').length - 1).toBe(1);
  }, SLOW);
});
