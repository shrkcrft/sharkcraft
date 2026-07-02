/**
 * The unified exit-code contract (a25 §1): 0 verified-pass / 1 failure /
 * 2 not-verified, with a global `--strict` that promotes NotVerified → Failure.
 */
import { describe, expect, test } from 'bun:test';
import { argvHasStrict, ExitCode, promoteForStrict } from '../exit-codes.ts';

describe('exit-code contract', () => {
  test('the three codes are stable', () => {
    expect(ExitCode.VerifiedPass).toBe(0);
    expect(ExitCode.Failure).toBe(1);
    expect(ExitCode.NotVerified).toBe(2);
  });

  test('promoteForStrict lifts NotVerified → Failure only under --strict', () => {
    expect(promoteForStrict(ExitCode.NotVerified, true)).toBe(ExitCode.Failure);
    expect(promoteForStrict(ExitCode.NotVerified, false)).toBe(ExitCode.NotVerified);
  });

  test('promoteForStrict never touches a real pass or a real failure', () => {
    expect(promoteForStrict(ExitCode.VerifiedPass, true)).toBe(ExitCode.VerifiedPass);
    expect(promoteForStrict(ExitCode.Failure, true)).toBe(ExitCode.Failure);
    // A non-contract code (e.g. a surface-not-enabled 3) passes through too.
    expect(promoteForStrict(3, true)).toBe(3);
  });

  test('argvHasStrict recognizes bare and valued forms, honors `--`', () => {
    expect(argvHasStrict(['check', 'wiring', '--strict'])).toBe(true);
    expect(argvHasStrict(['doctor', '--strict=warnings'])).toBe(true);
    expect(argvHasStrict(['check', 'wiring'])).toBe(false);
    // A `--strict` after the POSIX end-of-options separator is a literal, not the flag.
    expect(argvHasStrict(['gen', 'x', '--', '--strict'])).toBe(false);
  });
});
