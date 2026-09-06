/**
 * Round 74 — `shrk quality` reports EVERY failure in one pass.
 *
 * A CI job that chains gates as separate steps stops at the first failing step,
 * so N independent failures cost N round-trips to discover — fix gate A, push,
 * wait, watch gate B appear. The local aggregate exists to collapse that into
 * one run, which only works if it is exhaustive AND each failure carries the
 * command that reproduces it alone.
 *
 * The inspection is a REAL one over a real temp workspace. A hand-built
 * inspection literal would let the test pass against a shape production never
 * produces — which is how the bug it is supposed to lock ships anyway.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection, type IQualityConfig } from '@shrkcrft/inspector';
import type { IGateRuleView } from '../gates/gate-rule-view.ts';
import { runQuality } from '../quality/run-quality.ts';

let root: string;
let inspection: ISharkcraftInspection;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-quality-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'qfx', version: '0.0.0' }));
  writeFileSync(join(root, 'src/a.ts'), 'export const A = 1;\n');
  writeFileSync(
    join(root, 'sharkcraft/sharkcraft.config.ts'),
    "export default { projectName: 'qfx' };\n",
  );
  inspection = await inspectSharkcraft({ cwd: root });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function base(): Omit<Parameters<typeof runQuality>[0], 'failFast'> {
  return {
    inspection,
    config: {} as IQualityConfig,
    strict: false,
    cwd: root,
    excludeDirs: [],
    gateRules: [],
  };
}

describe('runQuality — exhaustive by default', () => {
  test('every inspector gate runs, and each carries an isolated repro command', async () => {
    const run = await runQuality({ ...base(), failFast: false });
    expect(run.items.length).toBeGreaterThan(1);
    for (const item of run.items) expect(item.repro.startsWith('shrk ')).toBe(true);
    // Not one shared "re-run the aggregate" line — each gate names its own verb.
    expect(new Set(run.items.map((i) => i.repro)).size).toBeGreaterThan(1);
  });

  test('the counts add up to the item list — a summary cannot contradict its rows', async () => {
    const run = await runQuality({ ...base(), failFast: false });
    expect(run.passed + run.failed + run.failedWarnings + run.skipped + run.errored).toBe(
      run.items.length,
    );
  });

  test('an unmeasured gate keeps the verdict off `pass`', async () => {
    const run = await runQuality({ ...base(), failFast: false });
    for (const item of run.items) {
      // `error` and `passed` are disjoint by construction; the point is that a
      // gate that could not run is never counted as green.
      if (item.status === 'error') expect(run.verdict).not.toBe('pass');
    }
  });
});

describe('runQuality — deliberate skips vs accidental ones', () => {
  const outOfScope: IGateRuleView[] = [
    { id: 'out-of-scope', plane: 'wiring', severity: 'error', failOnEmpty: true, raw: {} as never },
  ];

  test('a rule outside the changeset is skipped, and marked as REQUESTED', async () => {
    const run = await runQuality({ ...base(), failFast: false, skippedByScope: outOfScope });
    const skipped = run.items.find((i) => i.id === 'wiring:out-of-scope');
    expect(skipped?.status).toBe('skipped');
    // The user asked for the narrowing — treating it as an accidental skip
    // would make a pre-commit hook exit non-zero on every commit.
    expect(skipped?.skippedDeliberately).toBe(true);
  });

  test('a scope skip still names the command that runs that rule alone', async () => {
    const run = await runQuality({ ...base(), failFast: false, skippedByScope: outOfScope });
    expect(run.items.find((i) => i.id === 'wiring:out-of-scope')?.repro).toContain(
      '--only out-of-scope',
    );
  });

  test('every skipped item is either deliberate or reflected in the verdict', async () => {
    const run = await runQuality({ ...base(), failFast: false });
    const accidental = run.items.filter(
      (i) => i.status === 'skipped' && i.skippedDeliberately !== true,
    );
    if (accidental.length > 0) expect(run.verdict).toBe('not-verified');
  });
});
