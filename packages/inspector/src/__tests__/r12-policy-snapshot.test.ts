import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { inspectSharkcraft, runPolicySnapshot } from '../index.ts';

function makeFixture(): { cwd: string; fixtureDir: string; snapshotFile: string } {
  const cwd = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-snap-'));
  mkdirSync(nodePath.join(cwd, 'sharkcraft'), { recursive: true });
  writeFileSync(nodePath.join(cwd, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  writeFileSync(
    nodePath.join(cwd, 'sharkcraft', 'sharkcraft.config.ts'),
    `import { defineSharkCraftConfig } from '@shrkcrft/config';
export default defineSharkCraftConfig({ projectName: 'r12-snap' });`,
  );
  writeFileSync(
    nodePath.join(cwd, 'sharkcraft', 'policies.ts'),
    `const policies = [
  {
    id: 'r12.guard',
    title: 'r12 guard',
    severity: 'warning',
    checkType: 'path',
    evaluate({ planTargets }) {
      if (planTargets.some((p) => p.endsWith('.env'))) {
        return { message: 'cannot touch .env', suggestedFix: 'use env vars' };
      }
      return true;
    },
  },
];
export default policies;`,
  );
  const fixtureDir = nodePath.join(cwd, 'fixtures', 'r12.guard');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    nodePath.join(fixtureDir, 'policy-input.json'),
    JSON.stringify({ projectRoot: cwd, planTargets: ['.env'], bundleAffectedFiles: [] }),
  );
  return { cwd, fixtureDir, snapshotFile: nodePath.join(fixtureDir, 'snapshot.json') };
}

describe('r12 policy snapshot', () => {
  test('creates snapshot on first run', async () => {
    const { cwd, fixtureDir, snapshotFile } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd });
    const outcome = await runPolicySnapshot(
      inspection,
      { policyId: 'r12.guard', fixtureDir },
      { snapshotFile },
    );
    expect(outcome.updated).toBe(true);
    expect(existsSync(snapshotFile)).toBe(true);
    const saved = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    expect(saved.policyId).toBe('r12.guard');
    expect(saved.passed).toBe(false);
  });

  test('matches snapshot on subsequent run', async () => {
    const { cwd, fixtureDir, snapshotFile } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd });
    await runPolicySnapshot(inspection, { policyId: 'r12.guard', fixtureDir }, { snapshotFile });
    const second = await runPolicySnapshot(
      inspection,
      { policyId: 'r12.guard', fixtureDir },
      { snapshotFile },
    );
    expect(second.matchesSnapshot).toBe(true);
    expect(second.updated).toBe(false);
  });

  test('detects mismatch when behavior changes', async () => {
    const { cwd, fixtureDir, snapshotFile } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd });
    await runPolicySnapshot(inspection, { policyId: 'r12.guard', fixtureDir }, { snapshotFile });
    // Mutate the saved snapshot to simulate behavior change.
    const saved = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    saved.passed = !saved.passed;
    saved.message = 'something else';
    writeFileSync(snapshotFile, JSON.stringify(saved, null, 2));
    const next = await runPolicySnapshot(
      inspection,
      { policyId: 'r12.guard', fixtureDir },
      { snapshotFile },
    );
    expect(next.matchesSnapshot).toBe(false);
    expect(next.diffs.length).toBeGreaterThan(0);
  });

  test('--update-snapshot rewrites the file', async () => {
    const { cwd, fixtureDir, snapshotFile } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd });
    await runPolicySnapshot(inspection, { policyId: 'r12.guard', fixtureDir }, { snapshotFile });
    const saved = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    saved.message = 'old message';
    writeFileSync(snapshotFile, JSON.stringify(saved, null, 2));
    const updated = await runPolicySnapshot(
      inspection,
      { policyId: 'r12.guard', fixtureDir },
      { snapshotFile, updateSnapshot: true },
    );
    expect(updated.updated).toBe(true);
    expect(updated.matchesSnapshot).toBe(true);
  });
});
