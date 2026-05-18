/**
 * Phase 4 product-polish tests.
 * Covers `shrk ide file <path>` — per-file IDE data surface.
 */
import { describe, expect, test } from 'bun:test';
import { ideCommand } from '../commands/ide.command.ts';

async function captureStdout(
  fn: () => Promise<number> | number,
): Promise<{ exit: number; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as unknown) = (c: any): boolean => {
    chunks.push(typeof c === 'string' ? c : c.toString('utf8'));
    return true;
  };
  try {
    const exit = await fn();
    return { exit, out: chunks.join('') };
  } finally {
    (process.stdout.write as unknown) = orig;
  }
}

describe('IDE data surface', () => {
  test('shrk ide file <path> --json emits the v1 schema with the expected shape', async () => {
    const result = await captureStdout(() =>
      ideCommand.run({
        positional: ['file', 'packages/cli/src/main.ts'],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );

    expect(result.exit).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.schema).toBe('sharkcraft.ide.file/v1');
    expect(parsed.file.relativePath).toBe('packages/cli/src/main.ts');
    expect(parsed.file.exists).toBe(true);
    expect(Array.isArray(parsed.applicableRules)).toBe(true);
    expect(Array.isArray(parsed.relevantKnowledge)).toBe(true);
    expect(Array.isArray(parsed.suggestedCommands)).toBe(true);
    expect(parsed.suggestedCommands.length).toBeGreaterThan(0);
  });

  test('shrk ide with no verb prints usage and exits non-zero', async () => {
    const stderr: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as unknown) = (c: any): boolean => {
      stderr.push(typeof c === 'string' ? c : c.toString('utf8'));
      return true;
    };
    try {
      const result = await ideCommand.run({
        positional: [],
        flags: new Map(),
        multiFlags: new Map(),
      });
      expect(result).toBe(2);
      // ide now has three verbs (file / project / symbol).
      expect(stderr.join('')).toContain('Usage: shrk ide');
    } finally {
      (process.stderr.write as unknown) = origErr;
    }
  });
});
