/**
 * Round 11 (3.4) — the rule dry-run is the same engine as the gate.
 *
 * `gates try` exists so a selector is tightened BEFORE it is committed; it is
 * only worth anything if it answers exactly what the enforcing path will. Two
 * ways it did not:
 *   • the inline `--wiring` form had no way to spell regex flags, and split
 *     glob from pattern at the LAST colon — an anchored pattern matched only at
 *     file start, and a pattern containing `:` scanned 0 files;
 *   • a candidate's `selfTest` was silently discarded — no results, exit 0 over
 *     impossible expectations.
 *
 * Every assertion here runs a REAL config through the real handlers: the match
 * sets are compared across `gates try`, `gates coverage` and the registry the
 * gate reads, and the selfTest results across `gates try` and `gates coverage`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gatesCoverageCommand, gatesTryCommand } from '../commands/gates.command.ts';
import { registryCommand } from '../commands/registry.command.ts';
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

/** An anchored registry pattern: `^` must mean start-of-LINE, which needs the `m` flag. */
const REGISTRY = {
  name: 'tools',
  source: {
    files: ['src/tools/*.tool.ts'],
    extract: 'regex-capture',
    pattern: "^  name: '([a-z_]+)',?$",
    flags: 'm',
  },
};

const WIRING = {
  id: 'tools-registered',
  declared: {
    files: ['src/tools/*.tool.ts'],
    extract: 'regex-capture',
    pattern: '^export const (\\w+Tool)\\b',
    flags: 'm',
  },
  registered: { files: ['src/all.ts'], extract: 'regex-capture', pattern: '\\b(\\w+Tool)\\b' },
};

const FILES: Record<string, string> = {
  // Each file opens with a comment, so a `^` anchor WITHOUT the m flag (start
  // of FILE) can match nothing — only the m flag (start of LINE) can.
  // `nested_meta` sits at a deeper indent: the anchored pattern must NOT take it.
  'src/tools/a.tool.ts':
    "// the alpha tool\nexport const alphaTool = {\n  name: 'alpha_one',\n  meta: {\n    name: 'nested_meta',\n  },\n};\n",
  'src/tools/b.tool.ts': "// the beta tool\nexport const betaTool = {\n  name: 'beta_two',\n};\n",
  'src/all.ts': 'export const ALL = [alphaTool, betaTool];\n',
};

/** A real workspace: package.json, a real sharkcraft/sharkcraft.config.ts, real files. */
function workspace(config: Record<string, unknown>, files: Record<string, string> = FILES): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-try-'));
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

function ruleFile(root: string, name: string, rule: unknown): string {
  const file = join(root, name);
  writeFileSync(file, JSON.stringify(rule));
  return file;
}

function declaredTokens(explain: { declared: { sites: { token: string }[] } }): string[] {
  return [...new Set(explain.declared.sites.map((s) => s.token))].sort();
}

describe('3.4#1 — one compile path: an anchored pattern yields ONE match set everywhere', () => {
  test('PROPERTY: gates try --rule-file ≡ gates coverage ≡ the registry the gate reads (flags m)', async () => {
    const root = workspace({ registries: [REGISTRY] });
    const file = ruleFile(root, 'cand.json', REGISTRY);
    const tried = JSON.parse(
      (await run(gatesTryCommand, args(root, [], { 'rule-file': file, full: true, json: true }))).out,
    );
    const cov = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    const listed = JSON.parse((await run(registryCommand, args(root, ['tools', 'list'], { json: true }))).out);

    const viaTry = [...tried.coverage.allIds].sort();
    expect(viaTry).toEqual(['alpha_one', 'beta_two']);
    expect(viaTry).toEqual([...listed.ids].sort());
    const covRule = cov.rules.find((r: { id: string }) => r.id === 'tools');
    expect(covRule.unitsMatched).toBe(viaTry.length);
    expect([...covRule.sampleIds].sort()).toEqual(viaTry);
    expect(tried.exitCode).toBe(ExitCode.VerifiedPass);
  });

  test('WITHOUT the m flag both paths agree on 0 — and the dry-run says why', async () => {
    const noM = { name: 'tools', source: { ...REGISTRY.source, flags: undefined } };
    const root = workspace({ registries: [noM] });
    const file = ruleFile(root, 'cand.json', noM);
    const tried = await run(gatesTryCommand, args(root, [], { 'rule-file': file, json: true }));
    const body = JSON.parse(tried.out);
    const cov = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    expect(body.coverage.unitsMatched).toBe(0);
    expect(cov.rules[0].unitsMatched).toBe(0);
    expect(tried.code).toBe(ExitCode.NotVerified);
    expect(body.notes.join(' ')).toContain('no m flag');
    expect(body.notes.join(' ')).toContain("flags: 'm'");
  });

  test('inline --wiring with --flags m ≡ the equivalent rule-file ≡ gates coverage', async () => {
    const root = workspace({ wiringRules: [WIRING] });
    const spec = 'declared=src/tools/*.tool.ts:^export const (\\w+Tool)\\b registered=src/all.ts:\\b(\\w+Tool)\\b';
    const inline = await run(gatesTryCommand, args(root, [], { wiring: spec, flags: 'm', json: true }));
    const fromFile = await run(
      gatesTryCommand,
      args(root, [], { 'rule-file': ruleFile(root, 'w.json', WIRING), json: true }),
    );
    const cov = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    const a = JSON.parse(inline.out);
    const b = JSON.parse(fromFile.out);
    expect(declaredTokens(a)).toEqual(['alphaTool', 'betaTool']);
    expect(declaredTokens(a)).toEqual(declaredTokens(b));
    expect(cov.rules[0].unitsMatched).toBe(declaredTokens(a).length);
    expect(inline.code).toBe(ExitCode.VerifiedPass);
    expect(a.exitCode).toBe(inline.code);
  });

  test('inline WITHOUT --flags: the anchor matches only at file start, and the note names --flags m', async () => {
    const root = workspace({ wiringRules: [WIRING] });
    const spec = 'declared=src/tools/*.tool.ts:^export const (\\w+Tool)\\b registered=src/all.ts:\\b(\\w+Tool)\\b';
    const r = await run(gatesTryCommand, args(root, [], { wiring: spec, json: true }));
    const body = JSON.parse(r.out);
    expect(body.declared.distinctCount).toBe(0);
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(body.notes.join(' ')).toContain('pass --flags m');
  });

  test('an inline pattern containing ":" splits at the FIRST colon and scans the intended glob', async () => {
    const root = workspace({ wiringRules: [WIRING] });
    const spec =
      "declared=src/tools/*.tool.ts:name: '([a-z_]+)' registered=src/tools/*.tool.ts:name: '([a-z_]+)'";
    const body = JSON.parse((await run(gatesTryCommand, args(root, [], { wiring: spec, json: true }))).out);
    expect(body.declared.filesScanned).toBe(2);
    expect(declaredTokens(body)).toEqual(['alpha_one', 'beta_two', 'nested_meta']);
  });

  test('--flags with --rule-file is REFUSED (3), never silently ignored', async () => {
    const root = workspace({ registries: [REGISTRY] });
    const r = await run(
      gatesTryCommand,
      args(root, [], { 'rule-file': ruleFile(root, 'c.json', REGISTRY), flags: 'm' }),
    );
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.out).toContain('--flags applies to the inline --wiring form only');
  });
});

describe('3.4#2 — gates try evaluates the selfTest with the evaluator gates coverage uses', () => {
  const IMPOSSIBLE = { expectMatchesAtLeast: 999, expectIds: ['nope'], expectNotIds: ['alpha_one'] };

  test('an impossible selfTest on a registry candidate exits 1, with every expectation reported', async () => {
    const root = workspace({ registries: [REGISTRY] });
    const file = ruleFile(root, 'bad.json', { ...REGISTRY, selfTest: IMPOSSIBLE });
    const json = await run(gatesTryCommand, args(root, [], { 'rule-file': file, json: true }));
    const body = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.Failure);
    expect(body.exitCode).toBe(ExitCode.Failure);
    // floor, the missing positive fixture, the present negative fixture
    expect(body.coverage.expectationFailures).toHaveLength(3);
    expect(body.selfTest.failed).toBe(3);
    expect(body.selfTest.checks.map((c: { field: string }) => c.field)).toEqual([
      'expectMatchesAtLeast',
      'expectIds',
      'expectNotIds',
    ]);
    const text = await run(gatesTryCommand, args(root, [], { 'rule-file': file }));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('selfTest (3 expectation(s), 3 FAILED)');
    expect(text.out).toContain('FAILED — 3 selfTest expectation(s) failed');
  });

  test('a wiring candidate with an impossible selfTest exits 1; the explain payload stays top-level', async () => {
    const root = workspace({ wiringRules: [WIRING] });
    const file = ruleFile(root, 'w.json', { ...WIRING, selfTest: { expectIds: ['ghostTool'] } });
    const r = await run(gatesTryCommand, args(root, [], { 'rule-file': file, json: true }));
    const body = JSON.parse(r.out);
    expect(r.code).toBe(ExitCode.Failure);
    expect(body.selfTest.failures).toHaveLength(1);
    expect(body.selfTest.failures[0]).toContain('ghostTool');
    // back-compat: the explain keys a consumer already reads are still there
    expect(body.ruleId).toBe('tools-registered');
    expect(body.declared.distinctCount).toBe(2);
    expect(body.registered.distinctCount).toBe(2);
  });

  test('a satisfiable selfTest exits 0 and prints each expectation as held', async () => {
    const root = workspace({ registries: [REGISTRY] });
    const file = ruleFile(root, 'ok.json', {
      ...REGISTRY,
      selfTest: { expectMatchesAtLeast: 2, expectIds: ['alpha_one'], expectNotIds: ['nested_meta'] },
    });
    const r = await run(gatesTryCommand, args(root, [], { 'rule-file': file }));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out).toContain('selfTest (3 expectation(s))');
    expect(r.out.match(/held {9}/g)?.length).toBe(3);
    expect(r.out).toContain('every selfTest expectation held');
  });

  test('PROPERTY: one rule in config and in a rule file — try ≡ coverage, expectation for expectation', async () => {
    const bad = { ...REGISTRY, name: 'tools-bad', selfTest: IMPOSSIBLE };
    const root = workspace({ registries: [bad] });
    const tried = JSON.parse(
      (await run(gatesTryCommand, args(root, [], { 'rule-file': ruleFile(root, 'b.json', bad), json: true }))).out,
    );
    const cov = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    const inConfig = cov.rules.find((r: { id: string }) => r.id === 'tools-bad');
    expect(tried.coverage.expectationFailures).toEqual(inConfig.expectationFailures);
    expect(tried.coverage.selfTestChecks).toEqual(inConfig.selfTestChecks);
    expect(tried.coverage.status).toBe(inConfig.status);
  });

  test('an empty candidate still exits 2, and says what gates coverage would do with it', async () => {
    const root = workspace({ registries: [REGISTRY] });
    const stale = { name: 'stale', source: { files: ['src/moved/*.ts'], extract: 'export-names' } };
    const r = await run(gatesTryCommand, args(root, [], { 'rule-file': ruleFile(root, 's.json', stale) }));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('would exit 2 for it (failOnEmpty=false)');
    expect(r.out).toContain('NOT VERIFIED');
  });

  test('a registry candidate may carry failOnEmpty (no longer refused at validation)', async () => {
    const root = workspace({ registries: [REGISTRY] });
    const stale = { name: 'stale', failOnEmpty: true, source: { files: ['src/moved/*.ts'], extract: 'export-names' } };
    const r = await run(gatesTryCommand, args(root, [], { 'rule-file': ruleFile(root, 's.json', stale) }));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('would exit 1 for it (failOnEmpty=true)');
  });
});
