import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runSessionEval, DEFAULT_TRANSCRIPT } from '../compress-session-eval.ts';

// scripts/__tests__ → scripts → repo root.
const REPO_ROOT = join(import.meta.dir, '..', '..');

describe('compress-session-eval harness', () => {
  test(
    'replays the bundled transcript and reports a non-negative session reduction',
    async () => {
      const result = await runSessionEval({ cwd: REPO_ROOT });

      // Every transcript step is accounted for.
      expect(result.perTool.length).toBe(DEFAULT_TRANSCRIPT.length);
      // The high-volume read tools resolve against the live repo inspection.
      expect(result.perTool.some((r) => r.ok)).toBe(true);

      // Totals are well-formed and columnar mode never inflates the SESSION
      // total on the bundled transcript (a per-tool delta may be negative; the
      // aggregate must not be).
      expect(Number.isFinite(result.totals.tableOff)).toBe(true);
      expect(result.totals.tableOff).toBeGreaterThan(0);
      expect(result.totals.tableOn).toBeLessThanOrEqual(result.totals.tableOff);
      expect(result.totals.savedPct).toBeGreaterThanOrEqual(0);
    },
    60000,
  );
});
