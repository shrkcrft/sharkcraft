/**
 * Round 11 (L-4) — dead globs inside CONNECTED gate-plane rules.
 *
 * Per-rule dead detection already existed: a rule matching 0 is flagged. The
 * hole was one level down. A wiring rule over `['src/handlers/*.ts',
 * 'src/renamed-away/*.ts']` whose second directory was renamed keeps matching
 * through the first glob, so `gates coverage` printed "Every rule is connected
 * to something. ✓" while half the rule enforced nothing — 1.3's per-unit
 * defect, in the planes marketed as the trust layer.
 *
 * Advisory by default (the exit is unchanged), `--fail-on-dead-units` to fail —
 * the same flag name the boundary plane uses. `shrk quality` carries the
 * coverage verdict too, via the one derivation `gates coverage` settles with.
 * Real configs, real handlers, a real inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type IQualityConfig } from '@shrkcrft/inspector';
import { gatesCoverageCommand, prepare } from '../commands/gates.command.ts';
import { runQuality } from '../quality/run-quality.ts';
import { ExitCode } from '../exit-codes.ts';
import { parseArgs, type ParsedArgs } from '../command-registry.ts';
import { guardInvocation } from '../dispatch/guard-invocation.ts';
import { buildRegistry } from '../main.ts';

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

const FILES: Record<string, string> = {
  'src/handlers/a.ts': 'export const A_HANDLER = 1;\n',
  'src/handlers/b.ts': 'export const B_HANDLER = 2;\n',
  'src/registry.ts': 'export const HANDLERS = [A_HANDLER, B_HANDLER];\n',
};

const REGISTERED = { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' };

function wiring(declaredFiles: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'handlers-registered',
    declared: { files: declaredFiles, extract: 'export-names', match: '_HANDLER$' },
    registered: REGISTERED,
    ...extra,
  };
}

function policy(files: string[]): Record<string, unknown> {
  return { id: 'no-todo', surface: 'ts', files, pattern: 'TODO', message: 'no todo' };
}

/** The spec's fixture: one dead glob in each of two connected rules. */
const DEAD_CONFIG = {
  wiringRules: [wiring(['src/handlers/*.ts', 'src/renamed-away/*.ts'])],
  policyRules: [policy(['src/**/*.ts', 'old-dir/**/*.ts'])],
};

function workspace(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-dead-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default ${JSON.stringify(config, null, 2)};\n`,
  );
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function byId(rules: { id: string }[], id: string): Record<string, unknown> {
  return rules.find((r) => r.id === id) as unknown as Record<string, unknown>;
}

describe('L-4 — gates coverage reports dead globs inside connected rules', () => {
  test('each dead glob is named (with its side), counted, and the clean line is qualified', async () => {
    const root = workspace(DEAD_CONFIG);
    const json = await run(gatesCoverageCommand, args(root, [], { json: true }));
    const body = JSON.parse(json.out);
    const w = byId(body.rules, 'handlers-registered');
    const p = byId(body.rules, 'no-todo');
    expect(w['deadGlobs']).toEqual(['declared: src/renamed-away/*.ts']);
    expect(w['globsChecked']).toBe(3);
    expect(p['deadGlobs']).toEqual(['old-dir/**/*.ts']);
    expect(p['globsChecked']).toBe(2);
    expect(body.deadGlobCount).toBe(2);
    // Advisory by default: the exit is unchanged.
    expect(json.code).toBe(ExitCode.VerifiedPass);
    expect(body.exitCode).toBe(ExitCode.VerifiedPass);

    const text = await run(gatesCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    // Round 12 (12.2): each dead unit carries its reason, so a dead negation
    // ("excludes nothing") is never worded like a dead inclusion glob.
    expect(text.out).toContain('⚠ 1 of 3 glob(s) dead: declared: src/renamed-away/*.ts (matched 0 files)');
    expect(text.out).toContain('⚠ 1 of 2 glob(s) dead: old-dir/**/*.ts (matched 0 files)');
    expect(text.out).not.toContain('Every rule is connected to something. ✓');
    expect(text.out).toContain('but 2 glob(s) inside connected rules select or exclude nothing');
  });

  test('--fail-on-dead-units exits 1 in text and --json, and fails the rules that carry them', async () => {
    const root = workspace(DEAD_CONFIG);
    const json = await run(gatesCoverageCommand, args(root, [], { json: true, 'fail-on-dead-units': true }));
    const body = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.Failure);
    expect(body.gate.exit).toBe(ExitCode.Failure);
    expect(body.failOnDeadUnits).toBe(true);
    for (const r of body.gate.rules) expect({ id: r.id, status: r.status }).toEqual({ id: r.id, status: 'failed' });
    expect(
      body.gate.rules.flatMap((r: { violations: { id: string }[] }) => r.violations.map((v) => v.id)).sort(),
    ).toEqual(['declared: src/renamed-away/*.ts', 'old-dir/**/*.ts']);

    const text = await run(gatesCoverageCommand, args(root, [], { 'fail-on-dead-units': true }));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('--fail-on-dead-units is set — FAILED');
  });

  test('a dead REGISTERED sink is caught too — the half coverage used to be blind to', async () => {
    const root = workspace({
      wiringRules: [
        wiring(['src/handlers/*.ts'], {
          registered: [REGISTERED, { files: ['src/gone.ts'], extract: 'array-members', anchor: 'HANDLERS' }],
        }),
      ],
    });
    const body = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    expect(body.rules[0].deadGlobs).toEqual(['registered[1]: src/gone.ts']);
  });

  test('rules whose globs are all live keep today’s output', async () => {
    const root = workspace({ wiringRules: [wiring(['src/handlers/*.ts'])], policyRules: [policy(['src/**/*.ts'])] });
    const json = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    for (const r of json.rules) expect(r.deadGlobs).toEqual([]);
    expect(json.deadGlobCount).toBe(0);
    const text = await run(gatesCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('Every rule is connected to something. ✓');
    expect(text.out).not.toContain('⚠');
  });

  // Round 11 moved the inline per-verb flag guard into the dispatcher: `gates
  // coverage` DECLARES its complete flag set (`flags`, the identical set) and
  // `guardInvocation` refuses anything else BEFORE `run` — so the refusal is
  // asserted where it now happens, not by calling the handler directly.
  test('a mistyped flag is still refused (3), never read as a satisfied opt-in', () => {
    const root = workspace(DEAD_CONFIG);
    const rejection = guardInvocation({
      registry: buildRegistry(),
      handler: gatesCoverageCommand,
      matchedPath: ['gates', 'coverage'],
      trieChildren: [],
      parsed: parseArgs(['--fail-on-dead-unit'], { booleanFlags: gatesCoverageCommand.booleanFlags }),
      cwd: root,
    });
    expect(rejection?.exitCode).toBe(ExitCode.UsageError);
    expect(rejection?.message).toContain('Did you mean --fail-on-dead-units?');
  });
});

describe('shrk quality carries the coverage verdict (stale selectors + selfTest)', () => {
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

  test('dead globs ride along as advisory notes on a passing coverage item', async () => {
    const run = await quality(DEAD_CONFIG);
    const item = run.items.find((i) => i.id === 'gates-coverage');
    expect(item?.status).toBe('passed');
    expect(item?.notes.join('\n')).toContain(
      'advisory: 1 dead glob(s): declared: src/renamed-away/*.ts (matched 0 files)',
    );
  });

  test('a broken selfTest FAILS the before-you-push gate, with a repro naming the rule', async () => {
    const run = await quality({ wiringRules: [wiring(['src/handlers/*.ts'], { selfTest: { expectIds: ['GHOST_HANDLER'] } })] });
    const item = run.items.find((i) => i.id === 'gates-coverage');
    expect(item?.status).toBe('failed');
    expect(item?.severity).toBe('error');
    expect(item?.notes.join('\n')).toContain('GHOST_HANDLER');
    expect(item?.repro).toBe('shrk gates coverage --only handlers-registered');
    expect(run.exit).toBe(ExitCode.Failure);
  });
});
