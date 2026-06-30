/**
 * `shrk explain "<topic>"` must enumerate the matched items, not just count
 * them — otherwise it is strictly dominated by `shrk search`, which already
 * lists what matched.
 *
 *   - `--json` surfaces the actual relevantRules / relevantPaths /
 *     relevantTemplates arrays (with ids + titles), not only summary counts.
 *   - Human output lists each matched rule (id + title + priority), mirroring
 *     `shrk search`'s item formatting.
 *
 * The repo root is itself a SharkCraft project, so it serves as a fixture
 * with real rule/path matches for a generic topic like "rule".
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { explainCommand } from '../commands/daily.commands.ts';
import type { ParsedArgs } from '../command-registry.ts';

process.env.SHRK_DISABLE_AUTO_AI = '1';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

const writeOut = process.stdout.write.bind(process.stdout);

async function captureStdout<T>(fn: () => T | Promise<T>): Promise<{ value: T; stdout: string }> {
  let stdout = '';
  (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => {
    stdout += s;
    return true;
  }) as never;
  try {
    const value = await Promise.resolve(fn());
    return { value, stdout };
  } finally {
    process.stdout.write = writeOut as never;
  }
}

function makeArgs(positional: string[], flags: Array<[string, string | boolean]>): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>(flags),
    multiFlags: new Map<string, string[]>(),
  };
}

interface IExplainJson {
  topic: string;
  summary: {
    relevantRules: number;
    relevantPaths: number;
    relevantTemplates: number;
  };
  relevantRules: ReadonlyArray<{ id: string; title: string; priority: string }>;
  relevantPaths: ReadonlyArray<{ id: string; title: string; priority: string }>;
  relevantTemplates: ReadonlyArray<{ id: string; name: string }>;
}

describe('shrk explain enumerates matched items', () => {
  test('--json includes non-empty relevantRules / relevantPaths arrays, not just counts', async () => {
    const { value, stdout } = await captureStdout(() =>
      explainCommand.run(
        makeArgs(['rule'], [
          ['cwd', REPO_ROOT],
          ['json', true],
        ]),
      ),
    );
    expect(value).toBe(0);
    const parsed = JSON.parse(stdout) as IExplainJson;

    // Arrays are present (not just summary counts).
    expect(Array.isArray(parsed.relevantRules)).toBe(true);
    expect(Array.isArray(parsed.relevantPaths)).toBe(true);
    expect(Array.isArray(parsed.relevantTemplates)).toBe(true);

    // At least rules match for this topic, and they carry id + title.
    expect(parsed.relevantRules.length).toBeGreaterThan(0);
    expect(parsed.summary.relevantRules).toBe(parsed.relevantRules.length);
    for (const r of parsed.relevantRules) {
      expect(typeof r.id).toBe('string');
      expect(r.id.length).toBeGreaterThan(0);
      expect(typeof r.title).toBe('string');
    }

    // Array lengths agree with the summary counts (no drift between them).
    expect(parsed.summary.relevantPaths).toBe(parsed.relevantPaths.length);
    expect(parsed.summary.relevantTemplates).toBe(parsed.relevantTemplates.length);
  });

  test('human output lists each matched rule (id + title), not only a count line', async () => {
    const { value, stdout } = await captureStdout(() =>
      explainCommand.run(makeArgs(['rule'], [['cwd', REPO_ROOT]])),
    );
    expect(value).toBe(0);

    // It still prints the matches summary line.
    expect(stdout).toContain('rules=');
    // And now enumerates a Rules section with individual bulleted items.
    expect(stdout).toContain('Rules:');
    const bulletLines = stdout.split('\n').filter((l) => l.trim().startsWith('•'));
    expect(bulletLines.length).toBeGreaterThan(0);
    // Each enumerated rule line carries a priority bracket + an id/title.
    expect(bulletLines.some((l) => /\[[^\]]+\]/.test(l) && l.includes('—'))).toBe(true);
  });
});
