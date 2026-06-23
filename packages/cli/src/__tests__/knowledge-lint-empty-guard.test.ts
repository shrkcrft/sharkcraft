/**
 * `knowledge lint` must not silently look like a pass when it scanned nothing.
 * A 0-entry scan is the field-reported "Entries scanned: 0" no-op; the loud
 * stderr guard makes it unmistakable.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeLintCommand } from '../commands/knowledge-author.command.ts';

describe('knowledge lint empty guard', () => {
  test('warns loudly on stderr when 0 entries are scanned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-lint-empty-'));
    const errChunks: string[] = [];
    const errOrig = process.stderr.write.bind(process.stderr);
    const outOrig = process.stdout.write.bind(process.stdout);
    (process.stderr.write as unknown) = (c: unknown): boolean => {
      errChunks.push(typeof c === 'string' ? c : (c as Buffer).toString('utf8'));
      return true;
    };
    (process.stdout.write as unknown) = (): boolean => true; // silence stdout
    try {
      await knowledgeLintCommand.run({
        positional: ['lint'],
        flags: new Map<string, string | boolean>([['cwd', dir]]),
        multiFlags: new Map(),
      });
    } finally {
      (process.stderr.write as unknown) = errOrig;
      (process.stdout.write as unknown) = outOrig;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(errChunks.join('')).toContain('scanned 0 entries');
  });
});
