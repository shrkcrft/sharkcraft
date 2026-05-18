import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContradictionReport,
  buildGeneratedCodeReport,
  buildIngestAdoptionPlan,
  buildRepositoryKnowledgeModel,
  buildStabilityMap,
  IngestAdoptionStatus,
  IngestDepth,
  IngestSection,
  inspectSharkcraft,
  StabilityKind,
  writeIngestAdoption,
  writeIngestDrafts,
} from '../index.ts';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r26-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/r26-fixture',
      version: '0.0.0',
      type: 'module',
      scripts: { build: 'echo build', test: 'echo test' },
      devDependencies: { typescript: '^5' },
    }),
  );
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/index.ts'), 'export const ok = true;\n');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/overview.md'), '# Overview\n\nRun `sharkcraft doctor` to verify.\n\nSee `packages/missing/foo.ts` for details.\n');
  return root;
}

function makeRepoWithGenerated(): string {
  const root = makeRepo();
  mkdirSync(join(root, 'src/generated'), { recursive: true });
  writeFileSync(
    join(root, 'src/generated/api.ts'),
    '// @generated\n// DO NOT EDIT — produced by openapi-generator.\nexport const stub = 1;\n',
  );
  return root;
}

function makeRepoWithStability(): string {
  const root = makeRepo();
  mkdirSync(join(root, 'src/legacy'), { recursive: true });
  writeFileSync(join(root, 'src/legacy/old.ts'), 'export const x = 1;\n');
  mkdirSync(join(root, 'src/experimental'), { recursive: true });
  writeFileSync(join(root, 'src/experimental/new.ts'), 'export const y = 2;\n');
  mkdirSync(join(root, 'src/public'), { recursive: true });
  writeFileSync(join(root, 'src/public/index.ts'), 'export * from "../legacy/old";\n');
  return root;
}

describe('repository knowledge model', () => {
  test('builds a model with all sections by default', async () => {
    const root = makeRepo();
    const inspection = await inspectSharkcraft({ cwd: root });
    const model = await buildRepositoryKnowledgeModel({ inspection });
    expect(model.schema).toBe('sharkcraft.repository-knowledge-model/v1');
    expect(model.depth).toBe(IngestDepth.Standard);
    expect(model.selectedSections.length).toBeGreaterThan(10);
    expect(model.repositoryOverview.projectName).toBe('@example/r26-fixture');
  });

  test('include/exclude trims sections', async () => {
    const root = makeRepo();
    const inspection = await inspectSharkcraft({ cwd: root });
    const model = await buildRepositoryKnowledgeModel({
      inspection,
      selectedSections: [IngestSection.RepositoryOverview, IngestSection.ChangeProtocol],
      excludedSections: [IngestSection.RepositoryOverview],
    });
    expect(model.selectedSections).toEqual([IngestSection.ChangeProtocol]);
  });

  test('forced preset becomes transformational intent when no match', async () => {
    const root = makeRepo();
    const inspection = await inspectSharkcraft({ cwd: root });
    const model = await buildRepositoryKnowledgeModel({
      inspection,
      forcedPresetIds: ['modern-angular'],
    });
    expect(model.forcedPresetIds).toContain('modern-angular');
    // Repo has no Angular signal, so this is transformational intent.
    const note = model.transformationalIntents.join(' ');
    expect(note).toMatch(/modern-angular/);
  });
});

describe('ingest drafts', () => {
  test('writeIngestDrafts writes only under sharkcraft/ingestion/', async () => {
    const root = makeRepo();
    const inspection = await inspectSharkcraft({ cwd: root });
    const model = await buildRepositoryKnowledgeModel({ inspection });
    const result = writeIngestDrafts(model, { projectRoot: root });
    expect(result.outDir).toEqual(join(root, 'sharkcraft', 'ingestion'));
    for (const f of result.files) {
      expect(f.path.startsWith(result.outDir)).toBe(true);
    }
    expect(existsSync(join(result.outDir, 'repository-knowledge-model.json'))).toBe(true);
    expect(existsSync(join(result.outDir, 'generated', 'rules.draft.ts'))).toBe(true);
    expect(existsSync(join(result.outDir, 'CONTRADICTIONS.md'))).toBe(true);
  });
});

describe('contradictions', () => {
  test('detects deprecated CLI usage in docs', async () => {
    const root = makeRepo();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildContradictionReport({ inspection });
    const hasDeprecated = report.findings.some((f) => f.kind === 'old-cli-path');
    expect(hasDeprecated).toBe(true);
  });

  test('detects missing path reference', async () => {
    const root = makeRepo();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildContradictionReport({ inspection });
    const hasMissing = report.findings.some((f) => f.kind === 'missing-path' && f.reference.includes('packages/missing'));
    expect(hasMissing).toBe(true);
  });
});

describe('generated-code', () => {
  test('detects @generated / DO NOT EDIT files', async () => {
    const root = makeRepoWithGenerated();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildGeneratedCodeReport({ inspection });
    expect(report.generatedFiles.length).toBeGreaterThan(0);
    const found = report.generatedFiles.some((f) => f.path.includes('src/generated/api.ts'));
    expect(found).toBe(true);
    expect(report.protectedRules.length).toBeGreaterThan(0);
    expect(report.recommendedPolicyRules.length).toBeGreaterThan(0);
  });
});

describe('stability map', () => {
  test('classifies legacy + experimental + public-api folders', async () => {
    const root = makeRepoWithStability();
    const inspection = await inspectSharkcraft({ cwd: root });
    const map = buildStabilityMap({ inspection });
    const kinds = new Set(map.areas.map((a) => a.kind));
    expect(kinds.has(StabilityKind.Legacy)).toBe(true);
    expect(kinds.has(StabilityKind.Experimental)).toBe(true);
    expect(kinds.has(StabilityKind.PublicApi)).toBe(true);
  });
});

describe('adoption plan', () => {
  test('produces safe-append vs manual-review buckets and writes only under adoption/', async () => {
    const root = makeRepo();
    const inspection = await inspectSharkcraft({ cwd: root });
    const model = await buildRepositoryKnowledgeModel({ inspection });
    const plan = buildIngestAdoptionPlan({ model });
    expect(plan.schema).toBe('sharkcraft.ingest-adoption/v1');
    const total = Object.values(plan.counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(plan.entries.length);
    const written = writeIngestAdoption({ plan });
    expect(written.outDir).toEqual(join(root, 'sharkcraft', 'ingestion', 'adoption'));
    for (const f of written.files) expect(f.path.startsWith(written.outDir)).toBe(true);
    // Templates land in manual-review by default.
    const templateEntries = plan.entries.filter((e) => e.target === 'sharkcraft/templates.ts');
    if (templateEntries.length > 0) {
      expect(templateEntries.every((e) => e.status === IngestAdoptionStatus.ManualReview || e.status === IngestAdoptionStatus.AlreadyCovered || e.status === IngestAdoptionStatus.GeneratedProtected)).toBe(true);
    }
  });
});
