/**
 * Round 11 §1.2#3 / §6.2 — both lifecycle verbs share ONE body and settle
 * through the gate envelope.
 *
 * The bug: `check registry-lifecycle` over 2103 candidates scanned 2000, printed
 * `missing removers 0` and exited 0 — a real missing remover sat in the 103 it
 * never read, `--scope` did not reach them, and `--limit` / `--offset` were
 * silently ignored. Locked here from source, over a real workspace:
 *
 *   - a capped scan exits 2 on both verbs; the last line is NOT VERIFIED and
 *     names `--offset <n>`; `--json` carries exitCode 2 + nextOffset + gate;
 *   - `--offset` reaches the remainder (the missing remover → 1);
 *   - a malformed or unknown flag → 3;
 *   - a signal mid-scan prints the partial report (INTERRUPTED + --offset) → 2;
 *   - an empty scope is 2, and `--allow-empty` accepts it explicitly → 0.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runRegistryLifecycle } from '../commands/registry-lifecycle-run.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

const MAIN = resolve(import.meta.dir, '../main.ts');
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-lifecycle-cli-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const pair = (n: string): string =>
  `const m = new Map();\nexport function register${n}(id, x) { m.set(id, x); }\nexport function remove${n}(id) { m.delete(id); }\n`;
const miss = (n: string): string =>
  `const m = new Map();\nexport function register${n}(id, x) { m.set(id, x); }\nexport function clearAll() { m.clear(); }\n`;

/** a, b: clean pairs; c (last in sorted order): a real missing remover. */
const FILES = { 'src/a.ts': pair('A'), 'src/b.ts': pair('B'), 'src/c.ts': miss('C') };

function shrk(root: string, ...argv: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('bun', [MAIN, ...argv, '--cwd', root], { encoding: 'utf8', timeout: 90_000 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function lastLine(out: string): string {
  const lines = out.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
}

describe('both lifecycle verbs, spawned from source', () => {
  for (const verb of [['check', 'registry-lifecycle'], ['registry', 'lifecycle']] as const) {
    const label = verb.join(' ');

    test(`${label}: a capped scan exits 2 and names the continuation on the verdict line`, () => {
      const root = workspace(FILES);
      const text = shrk(root, ...verb, '--limit', '2');
      expect({ label, code: text.code }).toEqual({ label, code: ExitCode.NotVerified });
      expect(lastLine(text.out)).toContain('NOT VERIFIED');
      expect(lastLine(text.out)).toContain('--offset 2');
      expect(text.out).toContain('--offset 2');
      expect(text.out).not.toMatch(/\.\s*✓/);

      const json = shrk(root, ...verb, '--limit', '2', '--json');
      const body = JSON.parse(json.out);
      expect({ label, code: json.code, exitCode: body.exitCode, gate: body.gate.exit }).toEqual({
        label,
        code: ExitCode.NotVerified,
        exitCode: ExitCode.NotVerified,
        gate: ExitCode.NotVerified,
      });
      expect(body.nextOffset).toBe(2);
      expect(body.verdict).toBe('not-verified');
      expect(body.gate.verb).toBe(label);
      expect(body.gate.rules[0].type).toBe('lifecycle');
      expect(body.gate.coverage).toMatchObject({ unit: 'files', expected: 3, examined: 2, capped: true });
    }, 120_000);

    test(`${label}: --offset 2 reaches the remainder — the missing remover is a failure`, () => {
      const root = workspace(FILES);
      const r = shrk(root, ...verb, '--offset', '2');
      expect({ label, code: r.code }).toEqual({ label, code: ExitCode.Failure });
      expect(r.out).toContain('src/c.ts');
    }, 120_000);

    test(`${label}: a malformed or unknown flag is a usage error (3), never a silent default`, () => {
      const root = workspace(FILES);
      expect(shrk(root, ...verb, '--limit', 'abc').code).toBe(ExitCode.UsageError);
      expect(shrk(root, ...verb, '--offset', '-1').code).toBe(ExitCode.UsageError);
      expect(shrk(root, ...verb, '--bogus').code).toBe(ExitCode.UsageError);
    }, 120_000);
  }
});

// ── in-process: the shared runner ───────────────────────────────────────────

function args(root: string, flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional: [],
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((): boolean => true) as typeof process.stderr.write;
  try {
    return { code: await fn(), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('the shared runner, in process', () => {
  test('a signal before the first file prints the partial report — INTERRUPTED, --offset, exit 2', async () => {
    const root = workspace(FILES);
    const controller = new AbortController();
    controller.abort();
    const r = await capture(() => runRegistryLifecycle(args(root), 'check registry-lifecycle', { signal: controller.signal }));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('INTERRUPTED');
    expect(r.out).toContain('--offset 0');
    expect(r.out).toContain('NOT VERIFIED');
  });

  test('the signal handlers are released after the run', async () => {
    const before = process.listenerCount('SIGTERM');
    const root = workspace({ 'src/a.ts': pair('A') });
    await capture(() => runRegistryLifecycle(args(root), 'registry lifecycle'));
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  test('a complete clean scan is the only 0 — printed through the settled verdict line', async () => {
    const root = workspace({ 'src/a.ts': pair('A'), 'src/b.ts': pair('B') });
    const r = await capture(() => runRegistryLifecycle(args(root), 'check registry-lifecycle'));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out).toContain('No missing removers — 2 register* declaration(s) judged across 2 file(s). ✓');
  });

  test('nothing to judge is 2; --allow-empty accepts it explicitly and says so', async () => {
    const root = workspace({ 'src/plain.ts': 'export const x = 1;\n' });
    const empty = await capture(() => runRegistryLifecycle(args(root), 'check registry-lifecycle'));
    expect(empty.code).toBe(ExitCode.NotVerified);
    expect(empty.out).toContain('Pass --allow-empty');
    const accepted = await capture(() =>
      runRegistryLifecycle(args(root, { 'allow-empty': true }), 'check registry-lifecycle'),
    );
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('accepted by --allow-empty');
  });

  test('--allow-empty never accepts a capped scan', async () => {
    const root = workspace(FILES);
    const r = await capture(() =>
      runRegistryLifecycle(args(root, { 'allow-empty': true, limit: '1' }), 'check registry-lifecycle'),
    );
    expect(r.code).toBe(ExitCode.NotVerified);
  });
});

// ── round-11 review: the project config reaches the runner, or the run says it did not ──

/** A workspace with a real sharkcraft/sharkcraft.config.ts. */
function configured(config: Record<string, unknown>, files: Record<string, string>): string {
  return workspace({
    'sharkcraft/sharkcraft.config.ts': `export default ${JSON.stringify({ projectName: 'fx', ...config })};\n`,
    ...files,
  });
}

describe('registryLifecycle config through the runner (spawned from source)', () => {
  test('skipDirsAdd from a real config: the excluded miss is never read → 0', () => {
    const root = configured(
      { registryLifecycle: { skipDirsAdd: ['myexclude'] } },
      { 'src/ok.ts': pair('Ok'), 'myexclude/x.ts': miss('X') },
    );
    const r = shrk(root, 'check', 'registry-lifecycle');
    expect({ code: r.code, out: r.out }).toMatchObject({ code: ExitCode.VerifiedPass });
    expect(r.out).not.toContain('myexclude/x.ts');
  }, 120_000);

  test('a replacing skipDirs is honoured, and its dropped defaults point at skipDirsAdd', () => {
    const root = configured(
      { registryLifecycle: { skipDirs: ['myexclude'] } },
      { 'src/ok.ts': pair('Ok'), 'myexclude/x.ts': miss('X') },
    );
    const r = shrk(root, 'check', 'registry-lifecycle');
    expect(r.out).toContain('skipDirsAdd');
    expect(r.out).not.toContain('myexclude/x.ts');
  }, 120_000);

  test('an EXISTING config that fails to load never exits 0, and says why (review #3)', () => {
    // tools/ is skipped by default; the VALID config un-skips it, so its miss fails.
    const skipDirs = ['node_modules', 'dist', 'build', 'out', 'coverage', '.sharkcraft'];
    const files = { 'tools/t.ts': miss('X'), 'src/ok.ts': pair('Ok') };
    const valid = shrk(configured({ registryLifecycle: { skipDirs } }, files), 'check', 'registry-lifecycle');
    expect({ code: valid.code, out: valid.out }).toMatchObject({ code: ExitCode.Failure });

    // The same config plus a key the strict schema rejects: it used to fall
    // back silently to the default skip set and print ✓ / exit 0.
    const root = configured({ bogusKey: 1, registryLifecycle: { skipDirs } }, files);
    for (const verb of [['check', 'registry-lifecycle'], ['registry', 'lifecycle']] as const) {
      const text = shrk(root, ...verb);
      expect({ verb, code: text.code }).toEqual({ verb, code: ExitCode.NotVerified });
      expect(text.out).toContain('failed to load');
      expect(lastLine(text.out)).toContain('NOT VERIFIED');
      expect(text.out).not.toMatch(/\.\s*✓/);
      // --allow-empty waives an EMPTY scope only — never a config that did not load.
      expect(shrk(root, ...verb, '--allow-empty').code).toBe(ExitCode.NotVerified);
      const json = JSON.parse(shrk(root, ...verb, '--json').out);
      expect({ exitCode: json.exitCode, gate: json.gate.exit, verdict: json.verdict }).toEqual({
        exitCode: ExitCode.NotVerified,
        gate: ExitCode.NotVerified,
        verdict: 'not-verified',
      });
      expect(json.configCoverage).toMatchObject({ unit: 'config files', expected: 1, examined: 0 });
      expect(json.gate.rules.map((r: { id: string }) => r.id)).toContain('config');
    }
  }, 240_000);
});

describe('continuation, offset range, and the settled --json reason (review lows)', () => {
  test('the printed continuation keeps the global --cwd — and, pasted from elsewhere, reaches the remainder', () => {
    const root = workspace(FILES);
    const r = shrk(root, 'check', 'registry-lifecycle', '--limit', '2');
    const m = /Continue: shrk check registry-lifecycle --cwd (\S+) --limit 2 --offset 2/.exec(r.out);
    expect({ continuation: m?.[0] ?? r.out }).toEqual({ continuation: expect.stringContaining('--cwd') });
    expect(m?.[1]?.endsWith(basename(root))).toBe(true);
    // Run the pasted continuation from a DIFFERENT directory: it pages the right root.
    const pasted = spawnSync(
      'bun',
      [MAIN, 'check', 'registry-lifecycle', '--cwd', m![1]!, '--limit', '2', '--offset', '2'],
      { encoding: 'utf8', timeout: 90_000, cwd: tmpdir() },
    );
    expect(pasted.status).toBe(ExitCode.Failure);
    expect(pasted.stdout).toContain('src/c.ts');
  }, 120_000);

  test('an --offset past the last candidate is a usage error (3), even with --allow-empty', () => {
    const root = workspace(FILES);
    const r = shrk(root, 'check', 'registry-lifecycle', '--offset', '99', '--allow-empty');
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.err).toContain('--offset 99 is past the last candidate');
  }, 120_000);

  test('--json verdictReason is the SETTLED one: an accepted empty scope carries the acceptance; a failure, the engine reason', () => {
    const empty = workspace({ 'src/plain.ts': 'export const x = 1;\n' });
    const accepted = JSON.parse(shrk(empty, 'check', 'registry-lifecycle', '--allow-empty', '--json').out);
    expect({ exitCode: accepted.exitCode, verdict: accepted.verdict }).toEqual({
      exitCode: ExitCode.VerifiedPass,
      verdict: 'pass',
    });
    expect(accepted.verdictReason).toContain('accepted by --allow-empty');

    const failing = JSON.parse(shrk(workspace(FILES), 'check', 'registry-lifecycle', '--json').out);
    expect({ exitCode: failing.exitCode, verdict: failing.verdict, gate: failing.gate.verdict }).toEqual({
      exitCode: ExitCode.Failure,
      verdict: 'errors',
      gate: 'fail',
    });
    expect(failing.verdictReason).toContain('no matching remover');
  }, 120_000);
});
