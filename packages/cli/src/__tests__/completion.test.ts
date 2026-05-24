import { describe, expect, test } from 'bun:test';
import { completionCommand } from '../commands/completion.command.ts';

function makeArgs(positional: string[], flags: Record<string, string | boolean> = {}): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const flagMap = new Map<string, string | boolean>();
  for (const [k, v] of Object.entries(flags)) flagMap.set(k, v);
  return { positional, flags: flagMap, multiFlags: new Map() };
}

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

describe('shrk completion', () => {
  test('bash output includes the catalog verbs + graph subverbs', async () => {
    const cap = capture();
    const code = await completionCommand.run(makeArgs(['bash']));
    const out = cap.restore();
    expect(code).toBe(0);
    expect(out).toContain('complete -F _shrk_complete shrk');
    // top-level verbs we know exist
    expect(out).toContain(' doctor ');
    expect(out).toContain(' graph ');
    // graph subverbs we shipped this round
    expect(out).toContain('cycles unresolved deps');
  });

  test('zsh output uses compadd/compdef structure', async () => {
    const cap = capture();
    const code = await completionCommand.run(makeArgs(['zsh']));
    const out = cap.restore();
    expect(code).toBe(0);
    expect(out).toContain('compdef _shrk shrk');
    expect(out).toContain('compadd');
  });

  test('fish output is a sequence of `complete -c shrk` statements', async () => {
    const cap = capture();
    const code = await completionCommand.run(makeArgs(['fish']));
    const out = cap.restore();
    expect(code).toBe(0);
    expect(out).toContain('complete -c shrk');
    expect(out).toContain("__fish_seen_subcommand_from graph");
  });

  test('--json emits a stable schema payload', async () => {
    const cap = capture();
    const code = await completionCommand.run(makeArgs(['bash'], { json: true }));
    const out = cap.restore();
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.schema).toBe('sharkcraft.cli-completion/v1');
    expect(json.verbs).toContain('graph');
    expect(json.subverbs.graph).toContain('cycles');
  });

  test('rejects unknown shells', async () => {
    const cap = capture();
    const code = await completionCommand.run(makeArgs(['powershell']));
    cap.restore();
    expect(code).toBe(2);
  });
});
