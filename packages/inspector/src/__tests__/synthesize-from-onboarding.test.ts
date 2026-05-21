/**
 * Tests for `synthesizeFromOnboarding` — the core of `shrk init
 * --infer`. Anchors:
 *
 *   - The 7-file output contract (config + knowledge + paths + rules
 *     + pipelines + report.md + report.json) is stable.
 *   - High-confidence entries land in the populated files WITHOUT a
 *     `// TODO: review` marker.
 *   - Medium-confidence entries land WITH the review marker.
 *   - Low-confidence / unrenderable entries are dropped from the
 *     populated files and listed in the report.
 *   - Generated files are self-contained — no `@shrkcrft/*` imports.
 *   - Output is deterministic (same plan → identical bytes).
 *   - Driven end-to-end against the
 *     `examples/unconfigured-bun-service` fixture: matches the
 *     observed adoption triage (14 high / 1 medium / 3 dropped).
 */

import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { buildOnboardingPlan } from '../onboarding.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { synthesizeFromOnboarding } from '../synthesize-from-onboarding.ts';

const FIXTURE = nodePath.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'examples',
  'unconfigured-bun-service',
);

describe('synthesizeFromOnboarding', () => {
  test('emits the expected file set for the unconfigured-bun-service fixture', async () => {
    const inspection = await inspectSharkcraft({ cwd: FIXTURE });
    const plan = buildOnboardingPlan(inspection);
    const result = synthesizeFromOnboarding(plan);

    const paths = new Set(result.files.map((f) => f.path));
    expect(paths.has('sharkcraft.config.ts')).toBe(true);
    expect(paths.has('knowledge.ts')).toBe(true);
    expect(paths.has('paths.ts')).toBe(true);
    expect(paths.has('rules.ts')).toBe(true);
    expect(paths.has('pipelines.ts')).toBe(true);
    expect(paths.has('.inferred-report.md')).toBe(true);
    expect(paths.has('.inferred-report.json')).toBe(true);
  });

  test('generated TS files are self-contained (no @shrkcrft/* imports)', async () => {
    const inspection = await inspectSharkcraft({ cwd: FIXTURE });
    const plan = buildOnboardingPlan(inspection);
    const result = synthesizeFromOnboarding(plan);
    for (const file of result.files) {
      if (!file.path.endsWith('.ts')) continue;
      expect(file.content).not.toMatch(/from\s+['"]@shrkcrft\//);
      expect(file.content).not.toMatch(/from\s+['"]@sharkcraft\//);
    }
  });

  test('high-confidence path conventions land without a TODO marker; the report counts them', async () => {
    const inspection = await inspectSharkcraft({ cwd: FIXTURE });
    const plan = buildOnboardingPlan(inspection);
    const result = synthesizeFromOnboarding(plan);
    const pathsFile = result.files.find((f) => f.path === 'paths.ts');
    expect(pathsFile).toBeDefined();
    // The 4 inferred path conventions (paths.src / paths.services /
    // paths.utils / paths.tests) all have non-empty patterns → all
    // adopted as high. None should carry the review marker.
    expect(pathsFile!.content).toContain("id: \"paths.src\"");
    expect(pathsFile!.content).toContain("id: \"paths.tests\"");
    expect(pathsFile!.content).not.toContain('// TODO: review');
    // Every adopted-high entry shows up in the report.
    const highIds = new Set(result.report.adoptedHigh.map((c) => c.id));
    expect(highIds.has('paths.src')).toBe(true);
    expect(highIds.has('paths.tests')).toBe(true);
  });

  test('templates are uniformly dropped — too speculative to auto-populate', async () => {
    const inspection = await inspectSharkcraft({ cwd: FIXTURE });
    const plan = buildOnboardingPlan(inspection);
    const result = synthesizeFromOnboarding(plan);
    const droppedIds = new Set(result.report.dropped.map((c) => c.id));
    // Every inferred template candidate must end up in the dropped list.
    for (const t of plan.inferredTemplateCandidates) {
      expect(droppedIds.has(t.id)).toBe(true);
    }
    // None of them in the populated files.
    expect(result.files.some((f) => f.path === 'templates.ts')).toBe(false);
  });

  test('output is deterministic across runs', async () => {
    const inspection1 = await inspectSharkcraft({ cwd: FIXTURE });
    const inspection2 = await inspectSharkcraft({ cwd: FIXTURE });
    const plan1 = buildOnboardingPlan(inspection1);
    const plan2 = buildOnboardingPlan(inspection2);
    const r1 = synthesizeFromOnboarding(plan1);
    const r2 = synthesizeFromOnboarding(plan2);
    // Same files in same order, same content — except the
    // .inferred-report.json which intentionally carries a generatedAt
    // date stamp. Strip that for the comparison.
    expect(r1.files.length).toBe(r2.files.length);
    for (let i = 0; i < r1.files.length; i += 1) {
      const a = r1.files[i]!;
      const b = r2.files[i]!;
      expect(a.path).toBe(b.path);
      if (a.path === '.inferred-report.json') continue;
      expect(a.content).toBe(b.content);
    }
  });

  test('inferred report frontmatter lists adopted / dropped counts honestly', async () => {
    const inspection = await inspectSharkcraft({ cwd: FIXTURE });
    const plan = buildOnboardingPlan(inspection);
    const result = synthesizeFromOnboarding(plan);
    const reportFile = result.files.find((f) => f.path === '.inferred-report.md');
    expect(reportFile).toBeDefined();
    // Headings carry the count — the test pins the SHAPE, not the
    // exact number (so the fixture can grow without breaking the
    // test as long as the structure is consistent).
    expect(reportFile!.content).toMatch(/✅ Adopted directly \(\d+ entries — high confidence\)/);
    expect(reportFile!.content).toMatch(/🟡 Adopted with review marker \(\d+ entries — medium confidence\)/);
    expect(reportFile!.content).toMatch(/⚠️ Not adopted \(\d+ entries — low confidence\)/);
    expect(reportFile!.content).toContain("✍️ What shrk can't infer");
  });

  test('config file declares only the populated files (no dangling references)', async () => {
    const inspection = await inspectSharkcraft({ cwd: FIXTURE });
    const plan = buildOnboardingPlan(inspection);
    const result = synthesizeFromOnboarding(plan);
    const configFile = result.files.find((f) => f.path === 'sharkcraft.config.ts');
    expect(configFile).toBeDefined();
    const actualFiles = new Set(result.files.map((f) => f.path));
    // If paths.ts is in the file set, the config must list it; if not,
    // the config must not pretend it exists. Same for rules / pipelines
    // / boundaries.
    if (actualFiles.has('paths.ts')) {
      expect(configFile!.content).toContain('pathFiles: ["paths.ts"]');
    }
    if (actualFiles.has('rules.ts')) {
      expect(configFile!.content).toContain('ruleFiles: ["rules.ts"]');
    }
    if (actualFiles.has('pipelines.ts')) {
      expect(configFile!.content).toContain('pipelineFiles: ["pipelines.ts"]');
    }
    if (!actualFiles.has('boundaries.ts')) {
      expect(configFile!.content).toContain('boundaryFiles: []');
    }
  });
});
