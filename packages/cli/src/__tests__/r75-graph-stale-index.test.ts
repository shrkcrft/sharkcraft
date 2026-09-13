/**
 * r75 — a verdict DERIVED from the code-graph index is never clean over an
 * index behind the working tree (round 11 review R11-GAP-1).
 *
 * `graph cycles` (a registered verdict verb) never asked `detectGraphFreshness`:
 * after `graph index`, two new files importing each other left `graph status`
 * at `state stale` while `graph cycles` printed "No runtime cycles … ✓" and
 * exited 0 (`--json` `ok: true, total: 0`, no freshness field). It now settles
 * on the shared freshness coverage record: 2 in text and JSON with the changed
 * files named; a reindex shows the cycle at 0. `graph unresolved` (a listing,
 * exit unchanged) drops its ✓ over a stale index.
 *
 * Real temp projects and the real graph handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedArgs } from '../command-registry.ts';
import {
  runGraphCycles,
  runGraphIndex,
  runGraphStatus,
  runGraphUnresolved,
} from '../commands/graph-code-subverbs.ts';
import { ExitCode } from '../exit-codes.ts';

const SLOW = 120_000;

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(fn: (a: ParsedArgs) => Promise<number>, a: ParsedArgs): Promise<{ code: number; out: string }> {
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
    return { code: await fn(a), out };
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

/** Indexed with no cycle; then c1 ↔ c2 is added without a reindex. */
async function staleWithNewCycle(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-stale-graph-'));
  roots.push(root);
  write(root, 'package.json', JSON.stringify({ name: 'fx', version: '0.0.0' }));
  write(root, 'src/a.ts', 'export const a = 1;\n');
  expect((await run(runGraphIndex, args(root, ['index']))).code).toBe(0);
  write(root, 'src/c1.ts', "import { c2 } from './c2.ts';\nexport const c1 = () => c2;\n");
  write(root, 'src/c2.ts', "import { c1 } from './c1.ts';\nexport const c2 = () => c1;\n");
  return root;
}

describe('`graph cycles` over a stale index is NOT VERIFIED — never "No cycles ✓" (R11-GAP-1)', () => {
  test('graph status says stale; cycles is 2 in text and JSON, naming the changed files; a reindex shows the cycle at 0', async () => {
    const root = await staleWithNewCycle();
    const status = JSON.parse((await run(runGraphStatus, args(root, ['status'], { json: true }))).out) as { state: string };
    expect(status.state).toBe('stale');

    const text = await run(runGraphCycles, args(root, ['cycles']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('✓');
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('src/c1.ts');

    const json = JSON.parse((await run(runGraphCycles, args(root, ['cycles'], { json: true }))).out) as {
      exitCode: number;
      verdict: string;
      total: number;
      freshness: { state: string; behind: number };
      shortfalls: string[];
    };
    expect({ exitCode: json.exitCode, verdict: json.verdict, state: json.freshness.state, behind: json.freshness.behind }).toEqual({
      exitCode: 2,
      verdict: 'not-verified',
      state: 'stale',
      behind: 2,
    });
    expect(json.shortfalls.join(' ')).toContain('src/c2.ts');

    expect((await run(runGraphIndex, args(root, ['index']))).code).toBe(0);
    const fresh = await run(runGraphCycles, args(root, ['cycles'], { json: true }));
    const freshJson = JSON.parse(fresh.out) as { exitCode: number; total: number; freshness: { state: string } };
    expect({ code: fresh.code, exitCode: freshJson.exitCode, total: freshJson.total, state: freshJson.freshness.state }).toEqual({
      code: 0,
      exitCode: 0,
      total: 1,
      state: 'fresh',
    });
  }, SLOW);

  test('`graph unresolved` (a listing — exit unchanged) drops its ✓ over a stale index and names the gap', async () => {
    const root = await staleWithNewCycle();
    const text = await run(runGraphUnresolved, args(root, ['unresolved']));
    expect(text.code).toBe(0);
    expect(text.out).not.toContain('✓');
    expect(text.out).toContain('behind the working tree');
    const json = JSON.parse((await run(runGraphUnresolved, args(root, ['unresolved'], { json: true }))).out) as {
      freshness: { state: string };
    };
    expect(json.freshness.state).toBe('stale');
  }, SLOW);
});
