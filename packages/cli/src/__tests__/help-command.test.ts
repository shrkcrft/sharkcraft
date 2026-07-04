import { describe, expect, test } from 'bun:test';
import type { ICommandHandler } from '../command-registry.ts';
import { CommandRegistry } from '../command-registry.ts';
import { graphCommand } from '../commands/graph.command.ts';
import { makeHelpCommand } from '../commands/help.command.ts';

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

/** Capture stdout AND stderr independently for the same run. */
function captureBoth(): { restore: () => { out: string; err: string } } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    restore() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return { out, err };
    },
  };
}

const doctorStub: ICommandHandler = {
  name: 'doctor',
  description: 'Validate the workspace.',
  usage: 'shrk doctor',
  run: () => 0,
};

describe('help command', () => {
  test('help graph includes the inline code-intelligence subverbs', () => {
    const registry = new CommandRegistry();
    registry.register(graphCommand);
    const help = makeHelpCommand(registry);
    const cap = capture();
    const code = help.run({
      positional: ['graph'],
      flags: new Map<string, string | boolean>(),
    });
    const out = cap.restore();
    expect(code).toBe(0);
    expect(out).toContain('graph status');
    expect(out).toContain('graph context');
    expect(out).toContain('graph impact');
  });

  test('unknown topic errors instead of reprinting the catalog', () => {
    const registry = new CommandRegistry();
    registry.register(graphCommand);
    registry.register(doctorStub);
    const help = makeHelpCommand(registry);
    const cap = captureBoth();
    const code = help.run({
      positional: ['foobarnonsense'],
      flags: new Map<string, string | boolean>(),
    });
    const { out, err } = cap.restore();
    expect(code).toBe(1);
    expect(err).toContain("no such help topic:");
    expect(err).toContain('foobarnonsense');
    // The bug was reprinting the whole real catalog re-prefixed with the bogus
    // token — stdout must be empty and carry no re-prefixed verbs.
    expect(out).toBe('');
    expect(out).not.toContain('foobarnonsense init');
    expect(out).not.toContain('foobarnonsense doctor');
  });

  test('near-typo unknown topic suggests the real topic', () => {
    const registry = new CommandRegistry();
    registry.register(graphCommand);
    registry.register(doctorStub);
    const help = makeHelpCommand(registry);
    const cap = captureBoth();
    const code = help.run({
      positional: ['doctorz'],
      flags: new Map<string, string | boolean>(),
    });
    const { out, err } = cap.restore();
    expect(code).toBe(1);
    expect(err).toContain("no such help topic:");
    expect(err).toContain('Did you mean: doctor?');
    expect(out).toBe('');
  });

  test('a real group topic still lists its subverbs (exit 0)', () => {
    const registry = new CommandRegistry();
    registry.register(graphCommand);
    const help = makeHelpCommand(registry);
    const cap = captureBoth();
    const code = help.run({
      positional: ['graph'],
      flags: new Map<string, string | boolean>(),
    });
    const { out, err } = cap.restore();
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('graph status');
  });

  test('a real command topic still prints its usage (exit 0)', () => {
    const registry = new CommandRegistry();
    registry.register(doctorStub);
    const help = makeHelpCommand(registry);
    const cap = captureBoth();
    const code = help.run({
      positional: ['doctor'],
      flags: new Map<string, string | boolean>(),
    });
    const { out, err } = cap.restore();
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('doctor');
    expect(out).toContain('shrk doctor');
  });
});
