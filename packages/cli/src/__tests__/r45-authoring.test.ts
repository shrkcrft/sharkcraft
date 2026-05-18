/**
 * Phase 2 authoring tests.
 * Covers `shrk rules lint` + `--fix-preview` smallest-change suggestions.
 */
import { describe, expect, test } from 'bun:test';
import { rulesLintCommand } from '../commands/rules.command.ts';

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

describe('rules lint', () => {
  test('runs against the current workspace and surfaces findings', async () => {
    const result = await captureStdout(() =>
      rulesLintCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([['cwd', process.cwd()]]),
        multiFlags: new Map(),
      }),
    );
    expect(result.out).toContain('Rules lint');
    // Either rules are clean (exit 0) or there are findings (exit 1). Both are
    // acceptable; we just confirm the command ran and printed the header.
    expect([0, 1]).toContain(result.exit);
  });

  test('--fix-preview emits per-finding suggestions for known finding codes', async () => {
    const result = await captureStdout(() =>
      rulesLintCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['fix-preview', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(result.out).toContain('Fix-preview suggestions');
    // If the repo has clean rules, suggestions is empty; if it has findings,
    // at least one of our known codes should appear. The repo currently has
    // missing-examples findings, so the output should mention examples.
    if (result.exit === 1) {
      expect(result.out).toMatch(/examples|verificationCommands|actionHints/);
    }
  });

  test('--json returns a structured report', async () => {
    const result = await captureStdout(() =>
      rulesLintCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(() => JSON.parse(result.out)).not.toThrow();
    const parsed = JSON.parse(result.out);
    expect(parsed).toHaveProperty('report');
    expect(parsed).toHaveProperty('suggestions');
  });
});
