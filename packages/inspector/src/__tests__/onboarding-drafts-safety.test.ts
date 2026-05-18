import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOnboardingPlan,
  importAgentRulesForOnboarding,
  inspectSharkcraft,
  writeOnboardingDrafts,
} from '../index.ts';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-drafts-safety-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/drafts-safety',
      version: '0.0.0',
      type: 'module',
      scripts: { test: 'bun test', typecheck: 'tsc --noEmit' },
      devDependencies: { '@types/bun': '*' },
    }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  mkdirSync(join(root, 'src', 'utils'), { recursive: true });
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
    join(root, 'AGENTS.md'),
    '# rules\n\n- Always run tests before pushing.\n- Use absolute imports.\n',
  );
  return root;
}

describe('writeOnboardingDrafts — no writes outside sharkcraft/onboarding/', () => {
  test('every written file lives under sharkcraft/onboarding/', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, { scaffoldTemplates: true });
    const bundle = importAgentRulesForOnboarding({ projectRoot: root });
    const result = writeOnboardingDrafts(plan, {
      projectRoot: root,
      importedAgentRules: bundle,
    });
    for (const f of result.files) {
      expect(f.path.startsWith(result.outDir)).toBe(true);
    }
    // Pre-existing live config files are not created or touched.
    expect(existsSync(join(root, 'sharkcraft', 'rules.ts'))).toBe(false);
    expect(existsSync(join(root, 'sharkcraft', 'paths.ts'))).toBe(false);
    expect(existsSync(join(root, 'sharkcraft', 'templates.ts'))).toBe(false);
    expect(existsSync(join(root, 'sharkcraft', 'pipelines.ts'))).toBe(false);
    expect(existsSync(join(root, 'sharkcraft', 'boundaries.ts'))).toBe(false);
    // Only the onboarding subdir is created under sharkcraft/.
    const sharkcraftDir = join(root, 'sharkcraft');
    expect(existsSync(sharkcraftDir)).toBe(true);
    const entries = readdirSync(sharkcraftDir);
    expect(entries).toEqual(['onboarding']);
  });

  test('writes imported-agent-rules.draft.ts only with bundle entries', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection);
    const result = writeOnboardingDrafts(plan, { projectRoot: root });
    // No bundle provided → no agent-rules draft.
    expect(
      result.files.some((f) =>
        f.path.endsWith('imported-agent-rules.draft.ts'),
      ),
    ).toBe(false);
  });

  test('scaffolded entries embed the runnable: true marker in the templates draft', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, { scaffoldTemplates: true });
    const result = writeOnboardingDrafts(plan, { projectRoot: root });
    const draft = result.files.find((f) =>
      f.path.endsWith('inferred-templates.draft.ts'),
    )!;
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(draft.path, 'utf8');
    expect(body).toContain('runnable: true');
    expect(body).toContain('scaffold:');
    expect(body).toContain('<className>');
  });
});
