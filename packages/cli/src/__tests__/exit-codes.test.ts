/**
 * The unified exit-code contract (a25 §1): 0 verified-pass / 1 failure /
 * 2 not-verified, with a global `--strict` that promotes NotVerified → Failure.
 */
import { describe, expect, test } from 'bun:test';
import {
  argvHasExitTrailer,
  argvHasStrict,
  emitPipeExitSignal,
  ExitCode,
  isGateVerb,
  promoteForStrict,
} from '../exit-codes.ts';
import { extractGlobalExitTrailer } from '../command-registry.ts';
import { extractCommandPath } from '../usage/usage-log.ts';

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

describe('pipe-safe exit signal (a26 §2.1)', () => {
  test('argvHasExitTrailer recognizes the flag and honors `--`', () => {
    expect(argvHasExitTrailer(['finish', '--exit-trailer'])).toBe(true);
    expect(argvHasExitTrailer(['check', 'boundaries'])).toBe(false);
    expect(argvHasExitTrailer(['gen', 'x', '--', '--exit-trailer'])).toBe(false);
  });

  test('isGateVerb matches exact paths, subverbs, and top-level verbs', () => {
    expect(isGateVerb('finish')).toBe(true);
    expect(isGateVerb('check boundaries')).toBe(true);
    expect(isGateVerb('wiring unprovided')).toBe(true);
    expect(isGateVerb('wiring unprovided --json')).toBe(true); // extra tokens still resolve
    expect(isGateVerb('graph why')).toBe(true);
    // Non-gate verbs never trigger a pipe note.
    expect(isGateVerb('knowledge list')).toBe(false);
    expect(isGateVerb('gen')).toBe(false);
  });

  function collect(): { write: (s: string) => void; lines: () => string } {
    let body = '';
    return { write: (s) => void (body += s), lines: () => body };
  }

  test('warns on a piped NON-ZERO gate verdict — the masked case that loses info', () => {
    const c = collect();
    emitPipeExitSignal('check boundaries', ExitCode.NotVerified, {
      piped: true,
      trailer: false,
      write: c.write,
    });
    expect(c.lines()).toContain('stdout is piped');
    expect(c.lines()).toContain('PIPESTATUS[0]');
    expect(c.lines()).toContain('exit 2');
  });

  test('does NOT warn on a piped ZERO (masked 0→0 is harmless) or on a TTY', () => {
    const zero = collect();
    emitPipeExitSignal('finish', ExitCode.VerifiedPass, { piped: true, trailer: false, write: zero.write });
    expect(zero.lines()).toBe('');
    const tty = collect();
    emitPipeExitSignal('finish', ExitCode.Failure, { piped: false, trailer: false, write: tty.write });
    expect(tty.lines()).toBe('');
  });

  test('--exit-trailer emits `shrk-exit: <code>` on any code, as the last line', () => {
    const c = collect();
    emitPipeExitSignal('finish', ExitCode.Failure, { piped: true, trailer: true, write: c.write });
    // Warning first (non-zero + piped), trailer LAST so a caller reads the verdict off the tail.
    expect(c.lines().trimEnd().endsWith('shrk-exit: 1')).toBe(true);
    const clean = collect();
    emitPipeExitSignal('gate', ExitCode.VerifiedPass, { piped: false, trailer: true, write: clean.write });
    expect(clean.lines()).toBe('shrk-exit: 0\n'); // trailer alone on a passing, un-piped run
  });

  test('is a no-op for non-gate verbs even when piped with a trailer', () => {
    const c = collect();
    emitPipeExitSignal('knowledge list', ExitCode.Failure, { piped: true, trailer: true, write: c.write });
    expect(c.lines()).toBe('');
  });

  test('a LEADING --exit-trailer still resolves the command path (regression: was ""→no-op)', () => {
    // runCli derives the gate-verb command path from the --exit-trailer-stripped
    // argv; without the strip, extractCommandPath breaks on the leading '-' and
    // returns "" → isGateVerb("") false → the trailer/warning silently vanished.
    const raw = ['--exit-trailer', 'check', 'boundaries'];
    const stripped = extractGlobalExitTrailer(raw).rest;
    const path = extractCommandPath(stripped);
    expect(path).toBe('check boundaries');
    expect(isGateVerb(path)).toBe(true);
  });
});
