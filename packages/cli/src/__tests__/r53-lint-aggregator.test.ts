/**
 * Unified `shrk lint` verb.
 *
 * Locks in: --json shape is stable across runs; --kind focuses; exit
 * code reflects the underlying doctors.
 */
import { describe, expect, test } from 'bun:test';
import { lintCommand } from '../commands/lint.command.ts';

async function captureJson(
  fn: () => Promise<number> | number,
): Promise<{ exit: number; json: Record<string, unknown> }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (c: unknown): boolean => {
    chunks.push(typeof c === 'string' ? c : (c as Buffer).toString('utf8'));
    return true;
  };
  try {
    const exit = await fn();
    const json = JSON.parse(chunks.join('')) as Record<string, unknown>;
    return { exit, json };
  } finally {
    (process.stdout.write as unknown) = orig;
  }
}

describe('shrk lint aggregator', () => {
  test('--json shape is stable; default kind=all', async () => {
    const { json } = await captureJson(() =>
      lintCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    // schema bumped to v2 when the knowledge.errors hardcode was removed.
    expect(json['schema']).toBe('sharkcraft.lint/v2');
    expect(json['kind']).toBe('all');
    expect(json['knowledge']).toBeTruthy();
    expect(json['rules']).toBeTruthy();
    expect(json['templates']).toBeTruthy();
    const totals = json['totals'] as { errors: number; warnings: number; ready: boolean };
    expect(typeof totals.errors).toBe('number');
    expect(typeof totals.warnings).toBe('number');
    expect(typeof totals.ready).toBe('boolean');
  });

  test('--kind knowledge focuses on the knowledge slice only', async () => {
    const { json } = await captureJson(() =>
      lintCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['kind', 'knowledge'],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(json['kind']).toBe('knowledge');
    expect(json['knowledge']).toBeTruthy();
    expect(json['rules']).toBeUndefined();
    expect(json['templates']).toBeUndefined();
  });

  test('--kind rules focuses on the rules slice only', async () => {
    const { json } = await captureJson(() =>
      lintCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['kind', 'rules'],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(json['kind']).toBe('rules');
    expect(json['rules']).toBeTruthy();
    expect(json['knowledge']).toBeUndefined();
    expect(json['templates']).toBeUndefined();
  });

  test('--strict propagates and is reflected in the JSON', async () => {
    const { json } = await captureJson(() =>
      lintCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['strict', true],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(json['strict']).toBe(true);
  });

  test('exit code is 0 on a clean workspace, non-zero on findings', async () => {
    const { exit, json } = await captureJson(() =>
      lintCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    const totals = json['totals'] as { ready: boolean };
    if (totals.ready) {
      expect(exit).toBe(0);
    } else {
      expect(exit).toBe(1);
    }
  });
});
