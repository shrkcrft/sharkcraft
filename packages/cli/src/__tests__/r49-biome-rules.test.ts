/**
 * Biome bridge `rules` parity with ESLint.
 *
 * Locks in the `shrk biome rules` inventory: every row has a stable
 * status, the JSON shape is what extensions / dashboards expect, and the
 * usual suspects show up in `not-bridgeable` (plan / pack / signatures).
 */
import { describe, expect, test } from 'bun:test';
import { biomeRulesCommand } from '../commands/biome.command.ts';

async function capture(
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

describe('shrk biome rules', () => {
  test('--json emits an inventory of bridgeable/adjacent/not-bridgeable rows', async () => {
    const { exit, out } = await capture(() =>
      biomeRulesCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(typeof parsed.total).toBe('number');
    expect(parsed.rows).toBeInstanceOf(Array);
    const statuses = new Set<string>(
      parsed.rows.map((r: { status: string }) => r.status),
    );
    // The inventory must cover the not-bridgeable case (plan / signatures).
    expect(statuses.has('not-bridgeable')).toBe(true);
  });

  test('--filter narrows to one status only', async () => {
    const { exit, out } = await capture(() =>
      biomeRulesCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
          ['filter', 'not-bridgeable'],
        ]),
        multiFlags: new Map(),
      }),
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    for (const r of parsed.rows as Array<{ status: string }>) {
      expect(r.status).toBe('not-bridgeable');
    }
  });

  test('always lists a "safety" row covering the non-bridgeable surfaces', async () => {
    const { out } = await capture(() =>
      biomeRulesCommand.run({
        positional: [],
        flags: new Map<string, string | boolean>([
          ['cwd', process.cwd()],
          ['json', true],
        ]),
        multiFlags: new Map(),
      }),
    );
    const parsed = JSON.parse(out);
    const safetyRow = (parsed.rows as Array<{ kind: string; id: string; status: string }>).find(
      (r) => r.kind === 'safety',
    );
    expect(safetyRow).toBeDefined();
    expect(safetyRow?.status).toBe('not-bridgeable');
    expect(safetyRow?.id).toContain('plan-signing');
  });
});
