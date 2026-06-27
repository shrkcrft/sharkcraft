import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { codemodCommand } from '../commands/codemod.command.ts';
import { recommendCommand } from '../commands/recommend.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

function makeArgs(positional: string[], flags: Record<string, string | boolean>): ParsedArgs {
  return {
    positional,
    flags: new Map(Object.entries({ cwd: REPO_ROOT, ...flags })),
    multiFlags: new Map(),
  };
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

describe('shrk codemod list (discoverability)', () => {
  test('enumerates rule ids', async () => {
    const cap = capture();
    const code = await codemodCommand.run(makeArgs(['list'], {}));
    const out = cap.restore();
    expect(code).toBe(0);
    expect(out).toContain('Codemod rules (');
  });

  test('--json is parseable with an id field', async () => {
    const cap = capture();
    const code = await codemodCommand.run(makeArgs(['list'], { json: true }));
    const out = cap.restore();
    expect(code).toBe(0);
    const rules = JSON.parse(out) as { id: string }[];
    expect(rules.length).toBeGreaterThan(0);
    expect(typeof rules[0]!.id).toBe('string');
  });
});

describe('shrk recommend reconciles with the shared ranker', () => {
  test('a task the engine routes does NOT report a coverage gap', async () => {
    const cap = capture();
    const code = await recommendCommand.run(
      makeArgs(['add', 'a', 'new', 'CLI', 'command'], {}),
    );
    const out = cap.restore();
    expect(code).toBe(0);
    // The shared ranker matches a template/pipeline for this repo, so the false
    // "Coverage gap" verdict must be suppressed and the engine match surfaced.
    expect(out).not.toContain('Coverage gap');
  });

  test('--json includes the reconciled rankerMatch', async () => {
    const cap = capture();
    await recommendCommand.run(makeArgs(['add', 'a', 'new', 'CLI', 'command'], { json: true }));
    const out = cap.restore();
    const parsed = JSON.parse(out) as { rankerMatch?: unknown };
    expect('rankerMatch' in parsed).toBe(true);
  });
});
