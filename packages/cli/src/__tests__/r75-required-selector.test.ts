/**
 * Round 11, 1.2#5 — a per-item query verb with its required selector omitted
 * is a usage error, never "I checked and found nothing".
 *
 * `shrk tests missing` printed ZERO bytes and exited 0 with no `--files`;
 * `tests impact` / `owners impact` / `impact` rendered `(0 files)` — the last a
 * confident `Risk: low` — over nothing. Now: no selector → 3 with the usage
 * line; a selector that resolved to 0 files (`--since HEAD` on a clean tree) →
 * 2; a real selection → a real answer.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ICommandHandler, ParsedArgs } from '../command-registry.ts';
import { impactCommand } from '../commands/impact.command.ts';
import { ownersImpactCommand } from '../commands/owners.command.ts';
import { testsImpactCommand, testsMissingCommand } from '../commands/tests.command.ts';
import { ExitCode } from '../exit-codes.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** ParsedArgs exactly as `parseArgs` builds them: every string flag also lands in `multiFlags`. */
function args(cwd: string, flags: Record<string, string | boolean> = {}, positional: string[] = []): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', cwd], ...Object.entries(flags)]),
    multiFlags: new Map(
      Object.entries(flags)
        .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
        .map(([k, v]) => [k, [v]]),
    ),
  };
}

async function run(h: ICommandHandler, a: ParsedArgs): Promise<{ code: number; out: string; err: string }> {
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
    return { code: await h.run(a), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** A clean, committed git repo with one source file. */
function cleanRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-selector-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'sel', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'sel' };\n",
    'empty-plan.json': JSON.stringify({ changes: [] }),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const git = (...a: string[]): void =>
    void spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], {
      cwd: root,
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'r75');
  return root;
}

const HANDLERS: readonly (readonly [string, ICommandHandler])[] = [
  ['tests missing', testsMissingCommand],
  ['tests impact', testsImpactCommand],
  ['owners impact', ownersImpactCommand],
  ['impact', impactCommand],
];

describe('no selector → 3 with the usage line, and nothing on stdout', () => {
  for (const [verb, h] of HANDLERS) {
    test(verb, async () => {
      const r = await run(h, args(cleanRepo()));
      expect({ verb, code: r.code }).toEqual({ verb, code: ExitCode.UsageError });
      expect(r.err).toContain('Usage:');
      expect(r.err).toContain('no input selected');
      expect(r.out).toBe('');
    }, 60_000);
  }
});

describe('a selector that resolved to 0 files → 2 (nothing was analysed)', () => {
  const cases: readonly (readonly [string, ICommandHandler, Record<string, string | boolean>])[] = [
    ['tests missing --since HEAD', testsMissingCommand, { since: 'HEAD' }],
    ['tests impact --since HEAD', testsImpactCommand, { since: 'HEAD' }],
    ['owners impact --plan <empty plan>', ownersImpactCommand, { plan: 'empty-plan.json' }],
    ['impact --since HEAD', impactCommand, { since: 'HEAD' }],
  ];
  for (const [label, h, flags] of cases) {
    test(label, async () => {
      const r = await run(h, args(cleanRepo(), flags));
      expect({ label, code: r.code }).toEqual({ label, code: ExitCode.NotVerified });
    }, 60_000);
  }
});

describe('a real selection gets a real answer', () => {
  test('tests missing --files <existing file> never prints zero bytes', async () => {
    const r = await run(testsMissingCommand, args(cleanRepo(), { files: 'src/a.ts' }));
    expect(r.code).toBe(ExitCode.VerifiedPass);
    expect(r.out.length).toBeGreaterThan(0);
  }, 60_000);

  test('tests impact / owners impact --files run as before', async () => {
    for (const h of [testsImpactCommand, ownersImpactCommand]) {
      const r = await run(h, args(cleanRepo(), { files: 'src/a.ts' }));
      expect(r.code).toBe(ExitCode.VerifiedPass);
      expect(r.out.length).toBeGreaterThan(0);
    }
  }, 60_000);

  test('impact <file> is not a usage error', async () => {
    const r = await run(impactCommand, args(cleanRepo(), {}, ['src/a.ts']));
    expect(r.code).not.toBe(ExitCode.UsageError);
    expect(r.out.length).toBeGreaterThan(0);
  }, 60_000);
});
