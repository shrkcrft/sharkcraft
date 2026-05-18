import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { inspectSharkcraft, runPolicyTest, runPolicyTestsForAll } from '../index.ts';

function makeFixture(): {
  cwd: string;
  fixtureDir: string;
} {
  const cwd = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r11-policy-test-'));
  mkdirSync(nodePath.join(cwd, 'sharkcraft'), { recursive: true });
  writeFileSync(
    nodePath.join(cwd, 'package.json'),
    JSON.stringify({ name: 'r11-policy-test', version: '0.0.0' }),
    'utf8',
  );
  writeFileSync(
    nodePath.join(cwd, 'sharkcraft', 'sharkcraft.config.ts'),
    `import { defineSharkCraftConfig } from '@shrkcrft/config';
export default defineSharkCraftConfig({ projectName: 'r11-policy-test' });`,
    'utf8',
  );
  writeFileSync(
    nodePath.join(cwd, 'sharkcraft', 'policies.ts'),
    `const policies = [
  {
    id: 'r11.guard',
    title: 'r11 guard',
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
    'utf8',
  );
  const fixtureDir = nodePath.join(cwd, 'fixtures', 'r11.guard');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    nodePath.join(fixtureDir, 'policy-input.json'),
    JSON.stringify({ projectRoot: cwd, planTargets: ['.env'], bundleAffectedFiles: [] }),
    'utf8',
  );
  writeFileSync(
    nodePath.join(fixtureDir, 'expected.json'),
    JSON.stringify({ passed: false, messageContains: 'cannot touch .env' }),
    'utf8',
  );
  return { cwd, fixtureDir };
}

describe('r11 policy test harness', () => {
  test('runs a policy against an explicit fixture', async () => {
    const { cwd, fixtureDir } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd });
    const result = await runPolicyTest(inspection, {
      policyId: 'r11.guard',
      fixtureDir,
    });
    expect(result.policyId).toBe('r11.guard');
    expect(result.passed).toBe(false);
    expect(result.checks[0]!.message).toContain('cannot touch .env');
    expect(result.expectationOutcome?.matched).toBe(true);
  });

  test('runs against inline policyInput', async () => {
    const { cwd } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd });
    const result = await runPolicyTest(inspection, {
      policyId: 'r11.guard',
      policyInput: { projectRoot: cwd, planTargets: ['src/x.ts'], bundleAffectedFiles: [] },
    });
    expect(result.passed).toBe(true);
  });

  test('runPolicyTestsForAll without fixtures returns each registered policy', async () => {
    const { cwd } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd });
    const batch = await runPolicyTestsForAll(inspection);
    expect(batch.summary.total).toBeGreaterThan(0);
  });
});
