/**
 * CLI flag-honesty regressions (cluster cli-honesty-a).
 *
 * Each test pins a "papercut" where a CLI advertised a flag it never read, or
 * silently accepted a typo'd value and returned an empty result with exit 0:
 *
 *   C1 — `shrk trace --kind <k>` was advertised but ignored, so
 *        `trace graph --kind template` returned a *knowledge* best match. The
 *        flag is now read (engine filters by kind) and an unknown kind exits 2.
 *   C3 — `shrk plan simulate` usage advertised five phantom `--include-*` gate
 *        flags; the run() reads the inverse `--no-*`. Usage now tells the truth.
 *   C4 — `shrk commands --safety|--category <typo>` returned "commands (0)"
 *        exit 0. Both are now validated against an allowlist (exit 2).
 *   C6 — `shrk report --include-raw-json` was never read; dropped from usage.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { traceCommand } from '../commands/trace.command.ts';
import { makeCommandsCommand } from '../commands/commands.command.ts';
import { planSimulateCommand } from '../commands/plan-simulate.command.ts';
import { reportCommand } from '../commands/report.command.ts';
import { CommandRegistry, type ParsedArgs } from '../command-registry.ts';

// The repo itself is a sharkcraft workspace (it ships `engine.execution-graph`
// knowledge that scores for "graph"), so it's a stable target for the kind
// filter without standing up a fixture.
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');

function makeArgs(opts: {
  positional?: string[];
  flags?: Record<string, string | boolean>;
  multi?: Record<string, string[]>;
  cwd?: string;
}): ParsedArgs {
  return {
    positional: opts.positional ?? [],
    flags: new Map(Object.entries(opts.flags ?? {})),
    multiFlags: new Map(Object.entries(opts.multi ?? {})),
    ...(opts.cwd ? { globalCwd: opts.cwd } : {}),
  };
}

async function capture(
  fn: () => Promise<number> | number,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((s: any) => ((out += String(s)), true)) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((s: any) => ((err += String(s)), true)) as any;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function matchesOf(parsed: {
  bestMatch?: { kind: string };
  alternatives?: ReadonlyArray<{ kind: string }>;
}): ReadonlyArray<{ kind: string }> {
  return [parsed.bestMatch, ...(parsed.alternatives ?? [])].filter(Boolean) as Array<{
    kind: string;
  }>;
}

describe('shrk trace --kind (C1)', () => {
  test('an unknown --kind exits 2, lists the valid kinds, and prints nothing', async () => {
    const r = await capture(() =>
      traceCommand.run(makeArgs({ positional: ['graph'], multi: { kind: ['zzz'] } })),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown --kind "zzz"');
    // The rejection lists valid kinds so the user can self-correct.
    expect(r.err).toContain('knowledge');
    expect(r.err).toContain('template');
    // Rejected before resolving — no wrong-kind best match leaks to stdout.
    expect(r.out).toBe('');
  });

  test('without --kind, "graph" resolves to a knowledge match (the bug repro)', async () => {
    const r = await capture(() =>
      traceCommand.run(
        makeArgs({ positional: ['graph'], flags: { json: true }, cwd: REPO_ROOT }),
      ),
    );
    expect(r.code).toBe(0);
    const kinds = matchesOf(JSON.parse(r.out)).map((m) => m.kind);
    expect(kinds).toContain('knowledge');
  });

  test('--kind template filters the knowledge match out (flag is now read)', async () => {
    const r = await capture(() =>
      traceCommand.run(
        makeArgs({
          positional: ['graph'],
          flags: { json: true },
          multi: { kind: ['template'] },
          cwd: REPO_ROOT,
        }),
      ),
    );
    const matches = matchesOf(JSON.parse(r.out));
    // Every surviving match honours the requested kind...
    expect(matches.every((m) => m.kind === 'template')).toBe(true);
    // ...and the wrong-kind knowledge hit is gone.
    expect(matches.some((m) => m.kind === 'knowledge')).toBe(false);
  });

  test('--kind knowledge keeps only knowledge matches (positive filter)', async () => {
    const r = await capture(() =>
      traceCommand.run(
        makeArgs({
          positional: ['graph'],
          flags: { json: true },
          multi: { kind: ['knowledge'] },
          cwd: REPO_ROOT,
        }),
      ),
    );
    expect(r.code).toBe(0);
    const matches = matchesOf(JSON.parse(r.out));
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.kind === 'knowledge')).toBe(true);
  });
});

describe('shrk commands --safety / --category (C4)', () => {
  test('--safety <typo> exits 2 and lists the valid safety levels', async () => {
    const cmd = makeCommandsCommand(new CommandRegistry());
    const r = await capture(() => cmd.run(makeArgs({ flags: { safety: 'bogus' } })));
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown --safety "bogus"');
    expect(r.err).toContain('read-only');
    // The typo must not be silently swallowed into an empty listing.
    expect(r.out).toBe('');
  });

  test('--safety read-only is a real level and is accepted (exit 0)', async () => {
    const cmd = makeCommandsCommand(new CommandRegistry());
    const r = await capture(() => cmd.run(makeArgs({ flags: { safety: 'read-only' } })));
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });

  test('--category <typo> exits 2 and lists the valid categories', async () => {
    const cmd = makeCommandsCommand(new CommandRegistry());
    const r = await capture(() =>
      cmd.run(makeArgs({ flags: { category: 'not-a-real-category' } })),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown --category "not-a-real-category"');
  });
});

describe('shrk plan simulate usage honesty (C3)', () => {
  test('usage advertises the real --no-* gate flags, not phantom --include-*', () => {
    const usage = planSimulateCommand.usage ?? '';
    expect(usage).not.toContain('--include-boundaries');
    expect(usage).toContain('--no-boundaries');
    // --include-memory IS read, so it stays advertised.
    expect(usage).toContain('--include-memory');
  });
});

describe('shrk report usage honesty (C6)', () => {
  test('usage no longer advertises the never-read --include-raw-json', () => {
    expect(reportCommand.usage ?? '').not.toContain('--include-raw-json');
  });
});
