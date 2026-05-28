import { describe, expect, test } from 'bun:test';
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
});
