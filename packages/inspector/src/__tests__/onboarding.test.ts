import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOnboardingPlan, inspectSharkcraft, renderOnboardingReport, writeOnboardingDrafts } from '../index.ts';

function makeUnconfiguredFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-onboard-fixture-'));
  // package.json with the script set we care about
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/onboard-fixture',
      version: '0.0.0',
      type: 'module',
      scripts: {
        test: 'bun test',
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        build: 'echo build',
        'test:mutation': 'stryker run',
      },
      devDependencies: {
        '@types/bun': '*',
        typescript: '^5',
        eslint: '^9',
      },
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  // Folder layout: services/utils/tests + a few sample files.
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  mkdirSync(join(root, 'src', 'utils'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'services', 'user.service.ts'),
    'export class UserService {}\n',
  );
  writeFileSync(
    join(root, 'src', 'services', 'order.service.ts'),
    'export class OrderService {}\n',
  );
  writeFileSync(
    join(root, 'src', 'services', 'billing.service.ts'),
    'export class BillingService {}\n',
  );
  writeFileSync(
    join(root, 'src', 'utils', 'format.util.ts'),
    'export function fmt(x: number) { return String(x); }\n',
  );
  writeFileSync(
    join(root, 'src', 'utils', 'hash.util.ts'),
    'export function hash(x: string) { return x; }\n',
  );
  writeFileSync(
    join(root, 'tests', 'user.spec.ts'),
    "import { expect, test } from 'bun:test'; test('x', () => expect(1).toBe(1));\n",
  );
  return root;
}

function makeMonorepoLayerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-onboard-layers-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/layers-fixture',
      version: '0.0.0',
      workspaces: ['libs/*', 'apps/*'],
    }),
  );
  for (const layer of ['core', 'common', 'runtime', 'ui']) {
    mkdirSync(join(root, 'libs', layer), { recursive: true });
    writeFileSync(join(root, 'libs', layer, 'index.ts'), '// placeholder\n');
  }
  return root;
}

describe('buildOnboardingPlan', () => {
  test('infers path conventions from folder structure', async () => {
    const root = makeUnconfiguredFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const ids = plan.inferredPathConventions.map((p) => p.id);
    expect(ids).toContain('paths.src');
    expect(ids).toContain('paths.services');
    expect(ids).toContain('paths.utils');
    expect(ids).toContain('paths.tests');
  });

  test('infers verification commands from package.json scripts', async () => {
    const root = makeUnconfiguredFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const ids = plan.inferredVerificationCommands.map((v) => v.id);
    expect(ids).toContain('test');
    expect(ids).toContain('typecheck');
    expect(ids).toContain('lint');
    expect(ids).toContain('build');
    expect(ids).toContain('mutation-tests');
    // bun was detected via @types/bun, so commands use `bun run`.
    const test = plan.inferredVerificationCommands.find((v) => v.id === 'test')!;
    expect(test.command).toBe('bun run test');
  });

  test('infers template candidates from filename patterns', async () => {
    const root = makeUnconfiguredFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const ids = plan.inferredTemplateCandidates.map((t) => t.id);
    expect(ids).toContain('inferred.service');
    expect(ids).toContain('inferred.util');
    // 1 spec file → low confidence
    const spec = plan.inferredTemplateCandidates.find(
      (t) => t.id === 'inferred.spec',
    );
    expect(spec?.confidence).toBe('low');
    // 3 service files → high confidence
    const service = plan.inferredTemplateCandidates.find(
      (t) => t.id === 'inferred.service',
    )!;
    expect(service.confidence).toBe('high');
  });

  test('does not invent boundary rules from folder structure alone', async () => {
    const root = makeMonorepoLayerFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    // Boundary rules must be authored explicitly in sharkcraft/boundaries.ts —
    // the onboarding engine no longer guesses architecture shapes.
    expect(plan.inferredBoundaryRules).toEqual([]);
  });

  test('does not infer boundary rules when fewer than 3 layers detected', async () => {
    const root = makeUnconfiguredFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    expect(plan.inferredBoundaryRules.length).toBe(0);
  });

  test('readiness estimate reports current and expected grades', async () => {
    const root = makeUnconfiguredFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    expect(plan.readiness.current).toMatch(/poor|partial|good|excellent/);
    expect(plan.readiness.expected).toMatch(/poor|partial|good|excellent/);
    expect(plan.readiness.expectedScore).toBeGreaterThanOrEqual(
      plan.readiness.currentScore,
    );
    expect(plan.readiness.expectedScore - plan.readiness.currentScore).toBeLessThanOrEqual(20);
  });

  test('preferred preset is reordered to the front', async () => {
    const root = makeUnconfiguredFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {
      preferredPreset: 'bun-service',
    });
    expect(plan.recommendedPresets[0]?.preset.id).toBe('bun-service');
  });

  test('detects AGENTS.md / CLAUDE.md / .cursor/rules and suggests import commands', async () => {
    const root = makeUnconfiguredFixture();
    writeFileSync(join(root, 'AGENTS.md'), '# rules\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# claude\n');
    mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'rules', 'sample.mdc'),
      '---\ntitle: x\n---\nbody\n',
    );
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const kinds = plan.detectedInstructionFiles.map((f) => f.kind);
    expect(kinds).toContain('agents-md');
    expect(kinds).toContain('claude-md');
    expect(kinds).toContain('cursor-rules');
    expect(
      plan.detectedInstructionFiles.every((f) =>
        f.importCommand.startsWith('shrk import '),
      ),
    ).toBe(true);
  });

  test('renderOnboardingReport produces a stable Markdown document', async () => {
    const root = makeUnconfiguredFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const md = renderOnboardingReport(plan);
    expect(md).toContain('# SharkCraft onboarding report');
    expect(md).toContain('## AI-readiness — current vs. expected');
    expect(md).toContain('## Suggested rules');
    expect(md).toContain('## Suggested path conventions');
    expect(md).toContain('## Verification commands');
  });
});

describe('writeOnboardingDrafts', () => {
  test('writes 6 drafts under sharkcraft/onboarding only', async () => {
    const root = makeUnconfiguredFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const result = writeOnboardingDrafts(plan, { projectRoot: root });
    expect(result.files.length).toBe(6);
    for (const f of result.files) {
      expect(f.path.includes('sharkcraft/onboarding/')).toBe(true);
      expect(existsSync(f.path)).toBe(true);
    }
    // Specifically: NO file is created outside the onboarding subdir.
    expect(existsSync(join(root, 'sharkcraft', 'rules.ts'))).toBe(false);
    expect(existsSync(join(root, 'sharkcraft', 'paths.ts'))).toBe(false);
    expect(existsSync(join(root, 'sharkcraft', 'templates.ts'))).toBe(false);
  });
});
