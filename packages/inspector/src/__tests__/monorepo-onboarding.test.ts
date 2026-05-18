import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOnboardingPlan,
  inspectSharkcraft,
  renderOnboardingReport,
} from '../index.ts';

function makeMonorepoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-monorepo-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/monorepo',
      version: '0.0.0',
      type: 'module',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
      scripts: { test: 'bun test', build: 'echo build' },
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  for (const sub of ['apps/web', 'packages/core', 'packages/ui', 'packages/api']) {
    mkdirSync(join(root, sub, 'src'), { recursive: true });
    writeFileSync(
      join(root, sub, 'package.json'),
      JSON.stringify({
        name: `@example/${sub.split('/')[1]}`,
        scripts: { test: 'bun test' },
      }),
    );
    writeFileSync(join(root, sub, 'src', 'index.ts'), `export const ok = true;\n`);
  }
  return root;
}

describe('monorepo onboarding', () => {
  test('produces a monorepoSummary when workspaces are configured', async () => {
    const root = makeMonorepoFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    expect(plan.monorepoSummary).not.toBeNull();
    const m = plan.monorepoSummary!;
    expect(m.apps.length).toBe(1);
    expect(m.packages.length).toBe(3);
    expect(m.workspaces).toEqual(['apps/*', 'packages/*']);
    expect(m.rootVerificationCommands.length).toBeGreaterThan(0);
  });

  test('emits packages→apps boundary candidate', async () => {
    const root = makeMonorepoFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const m = plan.monorepoSummary!;
    expect(
      m.boundaryCandidates.some(
        (b) => b.id === 'architecture.packages.no-imports-from-apps',
      ),
    ).toBe(true);
  });

  test('renderOnboardingReport contains a Monorepo summary section', async () => {
    const root = makeMonorepoFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const md = renderOnboardingReport(plan);
    expect(md).toContain('## Monorepo summary');
    expect(md).toContain('Detected workspaces');
  });

  test('non-monorepo repo has monorepoSummary = null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-single-pkg-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@example/single', type: 'module' }),
    );
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    expect(plan.monorepoSummary).toBeNull();
  });

  test('produces per-package verification hints for each package script', async () => {
    const root = makeMonorepoFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const m = plan.monorepoSummary!;
    expect(m.perPackageVerificationHints.length).toBeGreaterThan(0);
    expect(
      m.perPackageVerificationHints.every((h) => h.command.includes('test')),
    ).toBe(true);
  });
});
