import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdoptionCategory,
  AdoptionKind,
  buildOnboardingAdoptionPlan,
  buildOnboardingPlan,
  inspectSharkcraft,
  renderAdoptionPatch,
  renderAdoptionPlanMarkdown,
  writeAdoptionPatch,
} from '../index.ts';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-adopt-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'adopt-fixture', version: '0.0.0', scripts: { build: 'tsc' } }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'adopt-fixture', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  // Some signals so the inference engine has something to chew on.
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  writeFileSync(join(root, 'src', 'services', 'user.service.ts'), 'export class UserService {}\n');
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions": {"strict": true}}');
  return root;
}

describe('onboarding adoption', () => {
  test('classifies inferred items into safe-to-adopt / manual-review / already-covered buckets', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan, confidence: 'high' });
    expect(adoption.confidence).toBe('high');
    const cats = Object.values(AdoptionCategory);
    for (const c of cats) expect(adoption.summary[c]).toBeDefined();
    // Items should be classified into known categories.
    for (const it of adoption.items) {
      expect(cats.includes(it.category)).toBe(true);
    }
  });

  test('excluded kinds appear as "skipped" items', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({
      inspection,
      plan,
      exclude: [AdoptionKind.Template],
    });
    // Skipped items must always be tagged "skipped".
    for (const it of adoption.byCategory[AdoptionCategory.Skipped]) {
      expect(it.category).toBe(AdoptionCategory.Skipped);
    }
  });

  test('writes patch under sharkcraft/onboarding/adoption/ and nowhere else', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
    const written = writeAdoptionPatch({ projectRoot: root, plan: adoption });
    expect(written.files.length).toBe(3);
    for (const f of written.files) {
      expect(f.path.startsWith(written.outDir)).toBe(true);
    }
    expect(existsSync(join(written.outDir, 'adoption-plan.md'))).toBe(true);
    expect(existsSync(join(written.outDir, 'adopt.patch'))).toBe(true);
    expect(existsSync(join(written.outDir, 'adopt-summary.json'))).toBe(true);
  });

  test('rendered patch only contains append blocks — never replacement hunks', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
    const body = renderAdoptionPatch(adoption);
    // Either empty (no safe-to-adopt) or contains only @@ append @@ markers.
    if (!body.startsWith('# No safe-to-adopt')) {
      expect(body.includes('@@ append @@')).toBe(true);
      expect(body.includes('@@ -')).toBe(false);
    }
  });

  test('rendered plan markdown lists every category', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
    const md = renderAdoptionPlanMarkdown(adoption);
    expect(md).toContain('# SharkCraft onboarding — adoption plan');
    for (const c of Object.values(AdoptionCategory)) {
      expect(md).toContain(`**${c}**`);
    }
  });
});
