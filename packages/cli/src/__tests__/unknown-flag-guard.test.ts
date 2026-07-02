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

describe('graph code-subverb flag guard', () => {
  test('a typo’d flag on a code-graph subverb is rejected as NotVerified', async () => {
    const args = parseArgs(['cycles', '--no-such-flag-xyz']);
    args.positional = ['cycles'];
    const code = await graphCommand.run(args);
    expect(code).toBe(ExitCode.NotVerified);
  });
});
