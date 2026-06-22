import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { movePlanCommand } from '../commands/move-plan.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

let tempRepo = '';

beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), 'shrk-move-plan-'));
});

afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
});

const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);

async function captureStdio<T>(fn: () => T | Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => {
    stdout += s;
    return true;
  }) as never;
  (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => {
    stderr += s;
    return true;
  }) as never;
  try {
    const value = await Promise.resolve(fn());
    return { value, stdout, stderr };
  } finally {
    process.stdout.write = writeOut as never;
    process.stderr.write = writeErr as never;
  }
}

function makeArgs(positional: string[], flags: Array<[string, string | boolean]>): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>(flags),
    multiFlags: new Map<string, string[]>(),
  };
}

describe('shrk move-plan — argument handling', () => {
  test('exits 2 with usage when args are missing', async () => {
    const { value, stderr } = await captureStdio(() =>
      movePlanCommand.run(makeArgs([], [['cwd', tempRepo]])),
    );
    expect(value).toBe(2);
    expect(stderr).toContain('Usage: shrk move-plan');
  });

  test('exits 1 when the source file does not exist', async () => {
    const { value, stderr } = await captureStdio(() =>
      movePlanCommand.run(makeArgs(['nope.ts', 'somewhere/else.ts'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(1);
    expect(stderr).toContain('Source file does not exist');
  });

  test('exits 1 when the target already exists', async () => {
    mkdirSync(join(tempRepo, 'src'), { recursive: true });
    writeFileSync(join(tempRepo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(tempRepo, 'src/b.ts'), 'export const b = 1;\n');
    const { value, stderr } = await captureStdio(() =>
      movePlanCommand.run(makeArgs(['src/a.ts', 'src/b.ts'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(1);
    expect(stderr).toContain('Target already exists');
  });

  test('exits 1 when no SharkCraft graph is available', async () => {
    mkdirSync(join(tempRepo, 'src'), { recursive: true });
    writeFileSync(join(tempRepo, 'src/a.ts'), 'export const a = 1;\n');
    const { value, stderr } = await captureStdio(() =>
      movePlanCommand.run(makeArgs(['src/a.ts', 'src/b.ts'], [['cwd', tempRepo]])),
    );
    expect(value).toBe(1);
    expect(stderr).toContain('No SharkCraft graph');
    expect(stderr).toContain('shrk graph index');
  });
});
