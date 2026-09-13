/**
 * a25 §2.1 — a graph/query verb must reject an unrecognized/misspelled flag
 * loudly instead of swallowing it as a silent `true` that reads as confident
 * success. Covers the shared `firstUnknownFlag` helper and the code-graph
 * command guard (an unknown flag → NotVerified `2`; a real flag → runs).
 */
import { describe, expect, test } from 'bun:test';
import { firstUnknownFlag, parseArgs } from '../command-registry.ts';
import { ExitCode } from '../exit-codes.ts';
import { graphCommand } from '../commands/graph.command.ts';
import { guardInvocation } from '../dispatch/guard-invocation.ts';
import { buildRegistry } from '../main.ts';

describe('firstUnknownFlag', () => {
  const allowed = new Set(['json', 'limit', 'include-type-edges']);

  test('returns undefined when every flag is recognized', () => {
    const args = parseArgs(['--json', '--include-type-edges']);
    expect(firstUnknownFlag(args, allowed)).toBeUndefined();
  });

  test('returns the first unrecognized flag', () => {
    const args = parseArgs(['--json', '--no-such-flag']);
    expect(firstUnknownFlag(args, allowed)).toBe('no-such-flag');
  });

  test('still catches an unknown flag even when it swallowed a positional', () => {
    // Without a booleanFlags hint the parser makes `--nope` consume `foo`;
    // the key `nope` is still unknown and must be reported.
    const args = parseArgs(['--nope', 'foo']);
    expect(firstUnknownFlag(args, allowed)).toBe('nope');
  });
});

describe('graph code-subverb flag guard (declared `flags`, judged by the dispatcher)', () => {
  // Round 11: the inline guard in `graph.run` became each code subverb's
  // declared `flags`; the dispatcher refuses an unknown flag BEFORE the subverb
  // runs, exiting `usageExitFor(path)` — 3 on the verdict verb `graph cycles`,
  // 2 on `graph importers` (the inline guard returned 2 for every subverb).
  const registry = buildRegistry();
  const guard = (argv: string[]) =>
    guardInvocation({
      registry,
      handler: graphCommand,
      matchedPath: ['graph'],
      trieChildren: [],
      parsed: parseArgs(argv),
      cwd: process.cwd(),
    });

  test('a typo’d flag on `graph cycles` (a verdict verb) is a usage error: 3', () => {
    const r = guard(['cycles', '--no-such-flag-xyz']);
    expect(r?.exitCode).toBe(ExitCode.UsageError);
    expect(r?.message).toContain('--no-such-flag-xyz');
  });

  test('…and on `graph importers` (not a verdict verb): 2', () => {
    expect(guard(['importers', 'x', '--no-such-flag-xyz'])?.exitCode).toBe(ExitCode.NotVerified);
  });

  test('a real flag and the global flags pass', () => {
    expect(guard(['cycles', '--include-type-edges', '--json'])).toBeUndefined();
    expect(guard(['cycles', '--no-hints', '--strict'])).toBeUndefined();
  });

  test('an asset-graph node id declares no flag set: the guard leaves it to the post-run detector', () => {
    expect(guard(['some-node', '--whatever'])).toBeUndefined();
  });
});
