/**
 * Rules authoring parity tests.
 *
 *   - `shrk rules add` forces `type='rule'` and refuses when --type is set
 *     to anything else.
 *   - `shrk rules remove` rejects unknown ids and ids whose type is not
 *     'rule', then delegates to `knowledge remove` (which enforces the
 *     reverse-reference check).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  rulesAddCommand,
  rulesRemoveCommand,
} from '../commands/rules.command.ts';

async function capture(
  fn: () => Promise<number> | number,
): Promise<{ exit: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (c: unknown): boolean => {
    outChunks.push(typeof c === 'string' ? c : (c as Buffer).toString('utf8'));
    return true;
  };
  (process.stderr.write as unknown) = (c: unknown): boolean => {
    errChunks.push(typeof c === 'string' ? c : (c as Buffer).toString('utf8'));
    return true;
  };
  try {
    const exit = await fn();
    return { exit, out: outChunks.join(''), err: errChunks.join('') };
  } finally {
    (process.stdout.write as unknown) = origOut;
    (process.stderr.write as unknown) = origErr;
  }
}

const ORIG_AGENT_ENV = process.env['SHARKCRAFT_AGENT'];

afterEach(() => {
  if (ORIG_AGENT_ENV === undefined) delete process.env['SHARKCRAFT_AGENT'];
  else process.env['SHARKCRAFT_AGENT'] = ORIG_AGENT_ENV;
});

describe('rules add / rules remove', () => {
  test('rules add refuses when --type is anything other than rule', async () => {
    const r = await capture(() =>
      rulesAddCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['id', 'r52-test-bad-type'],
          ['type', 'documentation'],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(r.exit).toBe(2);
    expect(r.err).toMatch(/forces type='rule'/);
  });

  test('rules add emits JSON whose entry.type is rule', async () => {
    const r = await capture(() =>
      rulesAddCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['id', 'r52.test.rules-add-json'],
          ['title', 'r52 test rule'],
          ['reason', 'test'],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(r.exit).toBe(0);
    expect(r.out).toContain('"operation": "add"');
    expect(r.out).toMatch(/"type":\s*"rule"/);
  });

  test('rules remove refuses an unknown id', async () => {
    const r = await capture(() =>
      rulesRemoveCommand.run({
        positional: ['r52-totally-missing-id'],
        flags: new Map<string, string | boolean>([['cwd', process.cwd()]]),
        multiFlags: new Map(),
      }),
    );
    expect(r.exit).toBe(1);
    expect(r.err).toMatch(/Unknown id/);
  });

  test('rules remove refuses an id whose type is not rule', async () => {
    // The SharkCraft workspace ships a non-rule knowledge entry. Find one
    // dynamically so the test stays robust against renames.
    const { inspectSharkcraft } = await import('@shrkcrft/inspector');
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const nonRule = inspection.knowledgeEntries.find((e) => e.type !== 'rule');
    if (!nonRule) return; // workspace is rules-only; nothing to assert.
    const r = await capture(() =>
      rulesRemoveCommand.run({
        positional: [nonRule.id],
        flags: new Map<string, string | boolean>([['cwd', process.cwd()]]),
        multiFlags: new Map(),
      }),
    );
    expect(r.exit).toBe(1);
    expect(r.err).toMatch(/type=|not "rule"/);
  });
});
