import { describe, expect, test } from 'bun:test';
import { renderIndexFreshnessWarning } from '../commands/smart-context.command.ts';

describe('renderIndexFreshnessWarning', () => {
  test('returns null when the index is current (no noise)', () => {
    expect(renderIndexFreshnessWarning(undefined)).toBeNull();
    expect(
      renderIndexFreshnessWarning({ indexed: 100, behind: 0, stale: 0, missing: 0, untracked: 0, refreshed: false }),
    ).toBeNull();
  });

  test('surfaces the drift counts when behind', () => {
    const w = renderIndexFreshnessWarning({ indexed: 100, behind: 5, stale: 2, missing: 1, untracked: 2, refreshed: false });
    expect(w).toContain('5 file(s) behind');
    expect(w).toContain('2 changed, 1 deleted, 2 new');
    expect(w).toContain('--refresh');
  });

  test('surfaces the pruned deleted-suggestion count when > 0', () => {
    const w = renderIndexFreshnessWarning({
      indexed: 100,
      behind: 4,
      stale: 1,
      missing: 3,
      untracked: 0,
      refreshed: false,
      prunedDeleted: 3,
    });
    expect(w).toContain('3 deleted-file suggestion(s) were dropped');
  });

  test('omits the pruned clause when prunedDeleted is 0/absent', () => {
    const w = renderIndexFreshnessWarning({ indexed: 100, behind: 2, stale: 2, missing: 0, untracked: 0, refreshed: false });
    expect(w).not.toContain('dropped from the list');
  });
});
