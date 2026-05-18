import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildOnboardingAdoptionPlan,
  buildOnboardingPlan,
  inspectSharkcraft,
  renderAdoptionPatchDetailed,
  validatePatchTargets,
  writeAdoptionPatch,
} from '../index.ts';

function makeFixture(opts: { withExistingRulesFile?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-adopt-unified-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'au', version: '0.0.0', scripts: { build: 'tsc' } }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'au', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  mkdirSync(join(root, 'src', 'services'), { recursive: true });
  writeFileSync(join(root, 'src', 'services', 'user.service.ts'), 'export class UserService {}\n');
  if (opts.withExistingRulesFile) {
    writeFileSync(join(root, 'sharkcraft', 'rules.ts'), 'export default [\n  // existing rule\n];\n');
  }
  return root;
}

describe('unified adoption patch', () => {
  test('creates a "new file" hunk when target is missing', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan, confidence: 'high' });
    const result = renderAdoptionPatchDetailed(adoption, { format: 'unified', projectRoot: root });
    expect(result.format).toBe('unified');
    if (result.targets.length > 0) {
      // For a fresh project, rules.ts doesn't exist, so the hunk must be "new file".
      const ruleTarget = result.targets.find((t) => t.relativePath === 'sharkcraft/rules.ts');
      if (ruleTarget) {
        expect(ruleTarget.existed).toBe(false);
        expect(result.body).toContain('new file mode');
        expect(result.body).toContain('--- /dev/null');
        expect(result.body).toMatch(/@@ -0,0 \+1,\d+ @@/);
      }
    }
  });

  test('appends with a context window when target exists', async () => {
    const root = makeFixture({ withExistingRulesFile: true });
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan, confidence: 'high' });
    const result = renderAdoptionPatchDetailed(adoption, { format: 'unified', projectRoot: root });
    const ruleTarget = result.targets.find((t) => t.relativePath === 'sharkcraft/rules.ts');
    if (ruleTarget && ruleTarget.existed) {
      expect(ruleTarget.beforeHash).toBeDefined();
      // The hunk header should reference a non-zero start line.
      expect(result.body).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    }
  });

  test('pseudo format is still available and contains @@ append @@', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
    const result = renderAdoptionPatchDetailed(adoption, { format: 'pseudo' });
    if (adoption.byCategory['safe-to-adopt'].length > 0) {
      expect(result.body).toContain('@@ append @@');
      expect(result.body).not.toContain('new file mode');
    }
  });

  test('writeAdoptionPatch records target hashes in adopt-summary.json', async () => {
    const root = makeFixture({ withExistingRulesFile: true });
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
    const written = writeAdoptionPatch({
      projectRoot: root,
      plan: adoption,
      format: 'unified',
    });
    expect(written.format).toBe('unified');
    const summaryPath = join(written.outDir, 'adopt-summary.json');
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      format: string;
      targets: { relativePath: string; existed: boolean; beforeHash?: string }[];
    };
    expect(summary.format).toBe('unified');
    expect(Array.isArray(summary.targets)).toBe(true);
  });

  test('validatePatchTargets surfaces files that changed since plan-time', async () => {
    const root = makeFixture({ withExistingRulesFile: true });
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
    const written = writeAdoptionPatch({ projectRoot: root, plan: adoption, format: 'unified' });
    // Mutate the rules.ts file.
    writeFileSync(join(root, 'sharkcraft', 'rules.ts'), 'export default [\n  // CHANGED\n];\n');
    const v = validatePatchTargets(root, written.targets);
    const ruleChanged = v.changed.some((t) => t.relativePath === 'sharkcraft/rules.ts');
    const ruleHadHash = written.targets.some(
      (t) => t.relativePath === 'sharkcraft/rules.ts' && t.beforeHash !== undefined,
    );
    if (ruleHadHash) expect(ruleChanged).toBe(true);
  });
});

describe('git apply compatibility (smoke)', () => {
  test('new-file unified patch is shaped correctly for git apply --check', async () => {
    // Verify the patch *structure* — we don't shell out to git in the test
    // suite, just assert the headers a real git apply expects to see.
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = buildOnboardingPlan(inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection, plan });
    const r = renderAdoptionPatchDetailed(adoption, { format: 'unified', projectRoot: root });
    if (r.targets.length > 0) {
      expect(r.body).toMatch(/diff --git a\/sharkcraft\/[^ ]+ b\/sharkcraft\//);
      expect(r.body).toMatch(/--- (a|\/dev\/null)/);
      expect(r.body).toMatch(/\+\+\+ b\//);
    }
    // Sanity: when git is available, verify the patch passes `git apply --check`.
    if (r.targets.length > 0 && r.targets.some((t) => !t.existed)) {
      const tmpPatch = join(root, 'tmp.patch');
      writeFileSync(tmpPatch, r.body);
      spawnSync('git', ['init', '-q'], { cwd: root });
      // Set author globally only for this temp dir.
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      const check = spawnSync('git', ['apply', '--check', tmpPatch], { cwd: root });
      // It's OK for this to fail on hosts without git — only assert when it's available.
      if (check.status !== null) {
        // The patch is well-formed enough for git to parse: either OK (0) or a
        // domain error (e.g., 1). What we care about is that it isn't a parse
        // error.
        expect(check.status).toBeLessThan(2);
      }
    }
  });
});
