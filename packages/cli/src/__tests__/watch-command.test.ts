import { describe, expect, test } from 'bun:test';
import { watchCommand } from '../commands/watch.command.ts';

describe('shrk watch — argument handling', () => {
  test('exits 2 with usage when no task is supplied', async () => {
    let stderr = '';
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => {
      stderr += s;
      return true;
    }) as never;
    try {
      const value = await watchCommand.run({
        positional: [],
        flags: new Map(),
        multiFlags: new Map(),
      });
      expect(value).toBe(2);
      expect(stderr).toContain('Usage: shrk watch');
    } finally {
      process.stderr.write = origErr as never;
    }
  });

  test('exits 1 with a hint when no semantic index exists', async () => {
    let stderr = '';
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => {
      stderr += s;
      return true;
    }) as never;
    try {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tempRepo = mkdtempSync(join(tmpdir(), 'shrk-watch-'));
      try {
        const value = await watchCommand.run({
          positional: ['hello', 'world'],
          flags: new Map<string, string | boolean>([['cwd', tempRepo]]),
          multiFlags: new Map(),
        });
        expect(value).toBe(1);
        expect(stderr).toContain('no semantic index');
        expect(stderr).toContain('embeddings-build');
      } finally {
        rmSync(tempRepo, { recursive: true, force: true });
      }
    } finally {
      process.stderr.write = origErr as never;
    }
  });
});
