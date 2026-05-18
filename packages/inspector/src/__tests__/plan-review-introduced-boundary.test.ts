import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { reviewSavedPlan } from '../plan-review.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

function symlinkWorkspace(root: string, name: string, relTarget: string): void {
  mkdirSync(join(root, 'sharkcraft', 'node_modules', '@shrkcrft'), {
    recursive: true,
  });
  spawnSync('ln', [
    '-s',
    join(REPO_ROOT, relTarget),
    join(root, 'sharkcraft', 'node_modules', '@shrkcrft', name),
  ]);
}

function makeFixture(): { root: string; planPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'shrk-plan-intro-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  symlinkWorkspace(root, 'config', 'packages/config');
  symlinkWorkspace(root, 'knowledge', 'packages/knowledge');
  symlinkWorkspace(root, 'templates', 'packages/templates');
  symlinkWorkspace(root, 'boundaries', 'packages/boundaries');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'plan-intro-fixture', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    [
      `export default {`,
      `  projectName: 'plan-intro-fixture',`,
      `  knowledgeFiles: [],`,
      `  ruleFiles: [],`,
      `  pathFiles: [],`,
      `  templateFiles: ['templates.ts'],`,
      `  docsFiles: [],`,
      `  boundaryFiles: ['boundaries.ts'],`,
      `};`,
    ].join('\n'),
  );
  // Template that, when rendered, contains an import line for a forbidden
  // package. The plan-review re-renders the template to recover this.
  writeFileSync(
    join(root, 'sharkcraft', 'templates.ts'),
    [
      `export const badImport = {`,
      `  id: 'bad.import',`,
      `  name: 'Bad import',`,
      `  description: 'Renders a file that imports a forbidden package.',`,
      `  tags: ['demo'],`,
      `  scope: ['ts'],`,
      `  appliesWhen: ['demo'],`,
      `  variables: [{ name: 'name', required: true }],`,
      `  targetPath: ({ name }) => 'libs/core/' + name + '.ts',`,
      `  content: () => "import 'forbidden-pkg';\\nexport {};\\n",`,
      `};`,
      `export default [badImport];`,
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'boundaries.ts'),
    [
      `export default [`,
      `  {`,
      `    id: 'core.no-forbidden',`,
      `    title: 'core may not import forbidden-pkg',`,
      `    severity: 'error',`,
      `    from: ['libs/core/**'],`,
      `    forbiddenImports: ['forbidden-pkg'],`,
      `    suggestedFix: 'Use an allowed dependency instead.',`,
      `  },`,
      `];`,
    ].join('\n'),
  );
  const planPath = join(root, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({
      schema: 'sharkcraft.plan/v1',
      templateId: 'bad.import',
      name: 'user',
      variables: { name: 'user' },
      projectRoot: root,
      createdAt: new Date().toISOString(),
      expectedChanges: [
        { type: 'create', relativePath: 'libs/core/user.ts', sizeBytes: 30 },
      ],
    }),
  );
  return { root, planPath };
}

describe('reviewSavedPlan plan-introduced boundary concerns', () => {
  test('flags violations introduced by the planned file contents', async () => {
    const { root, planPath } = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    // Sanity: the fixture template + boundary rule must be loaded for the
    // test to be meaningful.
    expect(inspection.templateRegistry.get('bad.import')).toBeDefined();
    expect(inspection.boundaryRegistry.get('core.no-forbidden')).toBeDefined();
    const report = reviewSavedPlan(inspection, planPath);

    // The plan creates a new file, so current-state violations should be empty
    // for that path (no file yet) — only the plan-introduced bucket fires.
    expect(report.planIntroducedBoundaryConcerns.length).toBeGreaterThan(0);
    const concern = report.planIntroducedBoundaryConcerns[0]!;
    expect(concern.file).toBe('libs/core/user.ts');
    expect(concern.ruleId).toBe('core.no-forbidden');
    expect(concern.importSpecifier).toBe('forbidden-pkg');
    expect(concern.suggestedFix).toContain('allowed');
  });
});
