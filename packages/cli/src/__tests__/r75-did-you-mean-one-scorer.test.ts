/**
 * r75 — one edit distance, one "did you mean" for an unknown DECLARED id
 * (round 11 review OA-5).
 *
 * The CLI's command-typo module re-implemented Levenshtein next to the
 * inspector's `levenshtein` (nearest-id.ts, which says "a second
 * implementation would drift"), and the new `test agent|context --id`
 * did-you-mean used the command-typo tolerance — so `--id auth-flow` offered
 * nothing where `checks --rule` would offer `auth-flow-smoke`. The distance is
 * now the inspector's, and every unknown-id site calls `nearestIds`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { levenshtein, nearestIds } from '@shrkcrft/inspector';
import type { ParsedArgs } from '../command-registry.ts';
import { testCommand } from '../commands/test.command.ts';
import { editDistance } from '../dispatch/closest-match.ts';
import { ExitCode } from '../exit-codes.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(Object.entries(flags).filter((kv): kv is [string, string] => typeof kv[1] === 'string').map(([k, v]) => [k, [v]])),
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

describe('one edit distance', () => {
  test('the CLI name IS the inspector function — not a copy', () => {
    expect(editDistance).toBe(levenshtein);
  });

  test('deterministic spot checks agree (the math never forked)', () => {
    const pairs: [string, string, number][] = [
      ['doctr', 'doctor', 1],
      ['', 'abc', 3],
      ['kitten', 'sitting', 3],
      ['auth-flow', 'auth-flow-smoke', 6],
    ];
    for (const [a, b, d] of pairs) expect({ a, b, d: editDistance(a, b) }).toEqual({ a, b, d });
  });
});

describe('`test agent --id` suggests exactly what every other unknown-id site suggests', () => {
  test('`--id auth-flow` → 3, "did you mean \'auth-flow-smoke\'" (nearestIds), never silence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r75-dym-'));
    roots.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
      'sharkcraft/agent-tests.ts': `export default [
  { id: 'auth-flow-smoke', task: 'check workspace health', expectedCommands: ['shrk doctor'] },
  { id: 'billing-route-test', task: 'check workspace health', expectedCommands: ['shrk doctor'] },
];
`,
    };
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    const expected = nearestIds('auth-flow', ['auth-flow-smoke', 'billing-route-test']).map((n) => n.id);
    expect(expected).toEqual(['auth-flow-smoke']);
    const r = await run(testCommand, args(root, ['agent'], { id: 'auth-flow' }));
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.out).toContain("did you mean 'auth-flow-smoke'?");
  }, 60_000);
});
