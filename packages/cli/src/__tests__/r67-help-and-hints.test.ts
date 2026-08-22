/**
 * A1 (`help <multi-word verb>`) and B2 (advisory-hint dosage).
 *
 * A1's real cause was subtler than "help can't join args": verbs like
 * `check wiring` are dispatched from inside their parent's handler on a
 * positional, so they are real, callable and catalogued — but never nodes in
 * the command trie. Help resolved only against the trie, so an entire
 * documented surface answered "Unknown command".
 */
import { describe, expect, test } from 'bun:test';
import { makeHelpCommand } from '../commands/help.command.ts';
import { CommandRegistry } from '../command-registry.ts';
import { COMMAND_CATALOG } from '../commands/command-catalog.ts';
import {
  argvHasNoHints,
  emitPipeExitSignal,
  resetPipeHintLatch,
} from '../exit-codes.ts';

function helpOutput(tokens: string[]): { code: number; out: string; err: string } {
  const registry = new CommandRegistry();
  // Only the PARENT is registered — exactly the real shape for `check wiring`.
  registry.register({ name: 'check', description: 'checks', usage: 'shrk check', run: () => 0 });
  const help = makeHelpCommand(registry);
  let out = '';
  let err = '';
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => { err += String(c); return true; }) as typeof process.stderr.write;
  try {
    const code = help.run({ positional: tokens, flags: new Map() }) as number;
    return { code, out, err };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

describe('A1 — help resolves catalog-documented multi-word verbs', () => {
  test('`help check wiring` documents the verb instead of "Unknown command"', () => {
    const r = helpOutput(['check', 'wiring']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('check wiring —');
    expect(r.err).not.toContain('Unknown command');
  });

  test('it lists sibling verbs so the family is discoverable from any member', () => {
    const r = helpOutput(['check', 'wiring']);
    expect(r.out).toContain('Siblings:');
    expect(r.out).toContain('check orphans');
  });

  test('a genuinely unknown path still fails honestly, with a suggestion', () => {
    const r = helpOutput(['check', 'wirinng']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no such help topic');
    expect(r.err).toContain('Did you mean');
  });

  test('every multi-word catalog command is reachable through help', () => {
    // The regression guard: if a new multi-word verb is catalogued but help
    // cannot render it, that surface is undocumented from the user's side.
    const multi = COMMAND_CATALOG
      .map((e) => e.command.split(/\s+--/)[0]!.trim())
      .filter((c) => c.split(' ').length === 2)
      .slice(0, 40);
    const unreachable = multi.filter((c) => helpOutput(c.split(' ')).code !== 0);
    expect(unreachable).toEqual([]);
  });
});

describe('B2 — the piped-exit hint is rationed, not removed', () => {
  test('a passing piped run emits nothing (the note is for lost verdicts only)', () => {
    resetPipeHintLatch();
    let s = '';
    emitPipeExitSignal('check wiring', 0, { piped: true, trailer: false, write: (x) => { s += x; } });
    expect(s).toBe('');
  });

  test('a failing piped run emits exactly one note', () => {
    resetPipeHintLatch();
    let s = '';
    emitPipeExitSignal('check wiring', 1, { piped: true, trailer: false, write: (x) => { s += x; } });
    expect(s).toContain('stdout is piped');
    expect(s).toContain('--no-hints');
  });

  test('it pays rent once per process, not once per verdict', () => {
    resetPipeHintLatch();
    let count = 0;
    const w = (x: string) => { if (x.startsWith('note:')) count += 1; };
    emitPipeExitSignal('check wiring', 1, { piped: true, trailer: false, write: w });
    emitPipeExitSignal('check wiring', 2, { piped: true, trailer: false, write: w });
    emitPipeExitSignal('baseline check', 1, { piped: true, trailer: false, write: w });
    expect(count).toBe(1);
  });

  test('--no-hints silences the advisory note', () => {
    resetPipeHintLatch();
    let s = '';
    emitPipeExitSignal('check wiring', 1, { piped: true, trailer: false, noHints: true, write: (x) => { s += x; } });
    expect(s).toBe('');
  });

  test('--no-hints does NOT silence the structured --exit-trailer channel', () => {
    resetPipeHintLatch();
    let s = '';
    emitPipeExitSignal('check wiring', 2, { piped: true, trailer: true, noHints: true, write: (x) => { s += x; } });
    expect(s).toBe('shrk-exit: 2\n');
  });

  test('argvHasNoHints stops at the `--` sentinel', () => {
    expect(argvHasNoHints(['check', 'wiring', '--no-hints'])).toBe(true);
    expect(argvHasNoHints(['check', 'wiring', '--', '--no-hints'])).toBe(false);
  });
});
