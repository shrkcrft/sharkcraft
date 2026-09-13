/**
 * Round 11 (4.3#2) — a policy rule's selfTest ids are its PATTERN MATCHES.
 *
 * The coverage adapter used to return `ids: []` for this plane unconditionally,
 * so every `expectIds` failed forever on a rule that worked perfectly and every
 * `expectNotIds` passed forever — a negative fixture asserting nothing.
 *
 * Decision: POPULATE the ids (capture group 1, else the whole match — exactly
 * the value the engine already reports per hit) rather than reject `expectIds`
 * at config load. The value is already computed; it gives a policy rule its
 * only pattern-liveness pin (an exempted fixture file proves the forbidden
 * pattern still bites); and rejecting at load would turn every existing config
 * that uses the field into exit 3 on every verb.
 *
 * Findings AND exempted hits count; a hit the rule's own `scan` zone dropped
 * does not — the zone says that text is prose, and letting it satisfy
 * `expectIds` would be the false signal zones exist to remove.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  gatesCoverageCommand,
  gatesExplainCommand,
  gatesScaffoldSelfTestCommand,
  gatesTryCommand,
} from '../commands/gates.command.ts';
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

/** `legacyCall('<id>')` — capture group 1 is the id. */
const LEGACY = "legacyCall\\(['\"]([a-z]+)['\"]";

function rule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'no-legacy-call',
    surface: 'ts',
    files: ['src/**/*.ts'],
    pattern: LEGACY,
    scan: 'code',
    exemptFiles: ['src/fixtures/**'],
    message: 'no legacyCall',
    ...extra,
  };
}

const FILES: Record<string, string> = {
  // An exempted fixture: real code the author deliberately allowed.
  'src/fixtures/legacy.ts': "legacyCall('boom');\n",
  // A hit INSIDE A COMMENT — the rule's own `scan: 'code'` zone drops it.
  'src/app.ts': "// legacyCall('ghost') was removed in the migration\nexport const x = 1;\n",
};

function workspace(policyRule: Record<string, unknown>, files: Record<string, string> = FILES): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-pol-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default ${JSON.stringify({ policyRules: [policyRule] }, null, 2)};\n`,
  );
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

async function coverage(root: string): Promise<{ code: number; rule: Record<string, unknown> }> {
  const r = await run(gatesCoverageCommand, args(root, [], { json: true }));
  return { code: r.code, rule: JSON.parse(r.out).rules[0] };
}

describe('4.3#2 — policy selfTest ids are the pattern matches', () => {
  test('an exempted fixture hit satisfies expectIds (it was permanently red)', async () => {
    const { code, rule: cov } = await coverage(workspace(rule({ selfTest: { expectIds: ['boom'] } })));
    expect(cov['status']).toBe('ok');
    expect(cov['sampleIds']).toEqual(['boom']);
    expect(code).toBe(ExitCode.VerifiedPass);
  });

  test('expectNotIds on a matched id now FAILS (it was vacuously green)', async () => {
    const { code, rule: cov } = await coverage(workspace(rule({ selfTest: { expectNotIds: ['boom'] } })));
    expect(cov['status']).toBe('failed-expectation');
    expect(String((cov['expectationFailures'] as string[])[0])).toContain('"boom"');
    expect(String((cov['expectationFailures'] as string[])[0])).toContain('policy rule "no-legacy-call"');
    expect(code).toBe(ExitCode.Failure);
  });

  test('a hit dropped only by the scan zone (a comment) does NOT satisfy expectIds', async () => {
    const { code, rule: cov } = await coverage(workspace(rule({ selfTest: { expectIds: ['ghost'] } })));
    expect(cov['status']).toBe('failed-expectation');
    expect(code).toBe(ExitCode.Failure);
  });

  test('PROPERTY: coverage ids ≡ the distinct matches `gates explain` reports as counted + exempted', async () => {
    const root = workspace(rule(), { ...FILES, 'src/bad.ts': "legacyCall('real');\n" });
    const explain = JSON.parse((await run(gatesExplainCommand, args(root, ['no-legacy-call'], { json: true }))).out);
    const fromEngine = [
      ...new Set([
        ...explain.findings.map((f: { match: string }) => f.match),
        ...explain.suppressed
          .filter((s: { via: string }) => s.via !== 'scanZone')
          .map((s: { match: string }) => s.match),
      ]),
    ].sort();
    const file = join(root, 'cand.json');
    writeFileSync(file, JSON.stringify(rule()));
    const tried = JSON.parse((await run(gatesTryCommand, args(root, [], { 'rule-file': file, full: true, json: true }))).out);
    expect(fromEngine).toEqual(['boom', 'real']);
    expect(tried.coverage.allIds).toEqual(fromEngine);
    // The exclusion is deliberate, not an accident of the fixture: the comment
    // hit IS in the engine's report — dropped by the zone.
    expect(
      explain.suppressed.some((s: { match: string; via: string }) => s.match === 'ghost' && s.via === 'scanZone'),
    ).toBe(true);
  });

  test('a clean rule with 0 hits stays connected (ok), counting content units — never `empty`', async () => {
    const { code, rule: cov } = await coverage(
      workspace(rule({ pattern: 'neverEverCalled\\(', exemptFiles: undefined, scan: undefined })),
    );
    expect(cov['status']).toBe('ok');
    expect(cov['unitsMatched']).toBe(2);
    expect(cov['sampleIds']).toEqual([]);
    expect(code).toBe(ExitCode.VerifiedPass);
  });

  test('scaffold-selftest now pins real policy ids (it scaffolded expectIds: [] before)', async () => {
    const root = workspace(rule());
    const r = await run(gatesScaffoldSelfTestCommand, args(root, ['no-legacy-call'], { json: true }));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(JSON.parse(r.out).expectIds).toContain('boom');
  });
});
