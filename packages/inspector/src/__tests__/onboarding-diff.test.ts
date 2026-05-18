import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOnboardingDiff,
  buildOnboardingPlan,
  inspectSharkcraft,
  renderOnboardingDiff,
} from '../index.ts';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-onboard-diff-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/diff-fixture',
      version: '0.0.0',
      type: 'module',
      scripts: {
        test: 'bun test',
        lint: 'eslint .',
        build: 'echo build',
        typecheck: 'tsc --noEmit',
      },
      devDependencies: { '@types/bun': '*', typescript: '^5' },
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  for (const n of ['user', 'order', 'billing']) {
    writeFileSync(
      join(root, 'src', 'services', `${n}.service.ts`),
      `export class ${n.charAt(0).toUpperCase()}${n.slice(1)}Service {}\n`,
    );
  }
  return root;
}

describe('buildOnboardingDiff', () => {
  test('reports inferred rules as missing when live config has none', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const diff = buildOnboardingDiff(inspection, plan);
    // No sharkcraft/rules.ts → all inferred rules are missing.
    expect(diff.rules.counts.missing).toBeGreaterThan(0);
    expect(diff.rules.counts.alreadyCovered).toBe(0);
    expect(
      diff.rules.entries.every((e) => e.status === 'missing'),
    ).toBe(true);
  });

  test('reports verification commands as missing when not configured', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const diff = buildOnboardingDiff(inspection, plan);
    expect(diff.verificationCommands.counts.missing).toBeGreaterThan(0);
  });

  test('flags low-confidence templates separately when not scaffolded', async () => {
    const root = makeFixture();
    // single spec file → low-confidence template candidate
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(
      join(root, 'tests', 'one.spec.ts'),
      `import { test } from 'bun:test'; test('x', () => {});\n`,
    );
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const diff = buildOnboardingDiff(inspection, plan);
    expect(
      diff.templates.entries.some((e) => e.status === 'low-confidence-only'),
    ).toBe(true);
  });

  test('renderOnboardingDiff produces stable Markdown', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const diff = buildOnboardingDiff(inspection, plan);
    const md = renderOnboardingDiff(diff);
    expect(md).toContain('# SharkCraft onboarding diff');
    expect(md).toContain('## Rules');
    expect(md).toContain('## Path conventions');
    expect(md).toContain('## Templates');
    expect(md).toContain('## Verification commands');
    expect(md).toContain('## Suggested manual merge steps');
  });
});
