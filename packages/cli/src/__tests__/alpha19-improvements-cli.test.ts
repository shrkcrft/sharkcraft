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

/**
 * Run `fn` with process.stdout captured, ALWAYS restoring the original writer
 * via try/finally — even if `fn` throws. The previous `capture()` returned a
 * `restore()` the caller had to remember to invoke after the awaited command;
 * if the command rejected (e.g. a transient EMFILE under heavy suite load), the
 * global `process.stdout.write` override leaked and cascaded into later tests.
 */
async function withCapture(
  fn: () => Promise<number> | number,
): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, out: body };
  } finally {
    process.stdout.write = orig;
  }
}

describe('shrk codemod list (discoverability)', () => {
  test('enumerates rule ids', async () => {
    const { code, out } = await withCapture(() => codemodCommand.run(makeArgs(['list'], {})));
    expect(code).toBe(0);
    expect(out).toContain('Codemod rules (');
  });

  test('--json is parseable with an id field', async () => {
    const { code, out } = await withCapture(() =>
      codemodCommand.run(makeArgs(['list'], { json: true })),
    );
    expect(code).toBe(0);
    const rules = JSON.parse(out) as { id: string }[];
    expect(rules.length).toBeGreaterThan(0);
    expect(typeof rules[0]!.id).toBe('string');
  });
});

describe('shrk recommend reconciles with the shared ranker', () => {
  test('a task the engine routes does NOT report a coverage gap', async () => {
    const { code, out } = await withCapture(() =>
      recommendCommand.run(makeArgs(['add', 'a', 'new', 'CLI', 'command'], {})),
    );
    expect(code).toBe(0);
    // The shared ranker matches a template/pipeline for this repo, so the false
    // "Coverage gap" verdict must be suppressed and the engine match surfaced.
    expect(out).not.toContain('Coverage gap');
  });

  test('--json includes the reconciled rankerMatch', async () => {
    const { out } = await withCapture(() =>
      recommendCommand.run(makeArgs(['add', 'a', 'new', 'CLI', 'command'], { json: true })),
    );
    const parsed = JSON.parse(out) as { rankerMatch?: unknown };
    expect('rankerMatch' in parsed).toBe(true);
  });
});
