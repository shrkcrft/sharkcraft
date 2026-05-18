/**
 * `shrk doctor --blockers` preset.
 *
 *   - Composes with --json (shape stable when --blockers is on or off).
 *   - Excludes action-hint-quality from the visible set.
 *   - Exit 0 on clean fixture, 1 when a blocker remains.
 */
import { describe, expect, test } from 'bun:test';
import { doctorCommand } from '../commands/doctor.command.ts';

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

describe('doctor --blockers', () => {
  test('--blockers --json includes the blockers preset metadata', async () => {
    const { exit, json } = await captureJson(() =>
      doctorCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['blockers', true],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect([0, 1]).toContain(exit);
    expect(json['blockers']).toBeTruthy();
    const blockers = json['blockers'] as {
      enabled: boolean;
      count: number;
      categories: readonly string[];
      excludes: readonly string[];
    };
    expect(blockers.enabled).toBe(true);
    expect(typeof blockers.count).toBe('number');
    expect(blockers.categories).toContain('config-invalid');
    expect(blockers.categories).toContain('pack-signature-invalid');
    expect(blockers.excludes).toContain('action-hint-quality');
  });

  test('default --json (no --blockers) reports blockers.enabled=false', async () => {
    const { exit, json } = await captureJson(() =>
      doctorCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect([0, 1]).toContain(exit);
    expect((json['blockers'] as { enabled: boolean }).enabled).toBe(false);
  });

  test('--blockers exit code is 0 on a clean workspace, matching blocker count', async () => {
    const { exit, json } = await captureJson(() =>
      doctorCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['blockers', true],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    const blockers = json['blockers'] as { count: number };
    // Exit code is non-zero iff blocker count > 0. The local workspace is
    // clean (verified by smoke), but other environments could legitimately
    // have blockers — the contract is the equivalence.
    if (blockers.count === 0) {
      expect(exit).toBe(0);
    } else {
      expect(exit).toBe(1);
    }
  });
});
