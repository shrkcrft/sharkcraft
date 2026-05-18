/**
 * feature accelerator tests.
 *
 * Covers:
 *  • Changed-only boundary filter
 *  • Plugin lifecycle plans (rename / remove)
 *  • Helper plans (add/remove plugin key, add barrel export)
 *  • Pack dev-status detection (source / symlink / signature staleness)
 *  • Registry lifecycle scanner (missing remover, ignore annotation)
 *  • Pack test runner (missing tests file, basic shape)
 *  • Ingest body extractor
 *  • Language runner allowlist (allow/deny/built-in deny)
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPluginRenamePlan,
  buildPluginRemovePlan,
  buildHelperPlan,
  ChangedScopeMode,
  HelperId,
  HELPERS,
  buildPackDevStatus,
  buildRegistryLifecycleReport,
  runPackTests,
  filterViolationsToChangedScope,
  resolveChangedFiles,
  extractIngestBody,
  getLanguageRunnerPolicy,
  explainCommandPolicy,
} from '../index.ts';
import {
  CaseStyle,
  PluginLifecycleRootKind,
  type IPluginLifecycleProfile,
} from '@shrkcrft/plugin-api';

/**
 * Fixture lifecycle profile used only inside this test suite. The
 * engine does not hardcode plugin paths; tests inject the profile
 * explicitly.
 */
const DEMO_FIXTURE_PROFILE: IPluginLifecycleProfile = {
  id: 'demo-fixture',
  title: 'Demo fixture profile',
  description: 'Test-only fixture profile.',
  pluginRoots: [
    { id: 'api', path: 'libs/demo/plugin/plugin-api/src/lib/plugins', kind: PluginLifecycleRootKind.Api },
    { id: 'cross', path: 'libs/demo/plugin/plugin-cross/src/lib/plugins', kind: PluginLifecycleRootKind.Cross },
    { id: 'angular', path: 'libs/demo/plugin/plugin-angular/src/lib/plugins', kind: PluginLifecycleRootKind.Angular },
  ],
  barrels: [
    { id: 'api', path: 'libs/demo/plugin/plugin-api/src/index.ts', exportSegment: './lib/plugins' },
    { id: 'cross', path: 'libs/demo/plugin/plugin-cross/src/index.ts', exportSegment: './lib/plugins' },
    { id: 'angular', path: 'libs/demo/plugin/plugin-angular/src/index.ts', exportSegment: './lib/plugins' },
  ],
  keyTable: {
    path: 'libs/demo/plugin/plugin-core/src/lib/types/FEATURE_KEYS.ts',
    keyCase: CaseStyle.UpperSnake,
    valueCase: CaseStyle.Camel,
  },
};

function makeTempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `r28-${prefix}-`));
}

describe('changed-only boundary filter', () => {
  test('filters out violations whose file is not in the changed set', () => {
    const root = makeTempRepo('cbf');
    const violations = [
      { ruleId: 'rule-a', file: 'libs/a/src/x.ts' },
      { ruleId: 'rule-b', file: 'libs/b/src/y.ts' },
      { ruleId: 'rule-a', file: 'libs/c/src/z.ts' },
    ];
    const result = filterViolationsToChangedScope(violations, {
      projectRoot: root,
      files: ['libs/a/src/x.ts', 'libs/c/src/z.ts'],
    });
    expect(result.includedViolations).toHaveLength(2);
    expect(result.ignoredLegacyCount).toBe(1);
    expect(result.ignoredLegacyByRule['rule-b']).toBe(1);
    expect(result.mode).toBe(ChangedScopeMode.Files);
    rmSync(root, { recursive: true });
  });

  test('uses fromFile when file is absent (polyglot)', () => {
    const root = makeTempRepo('cbf2');
    const violations = [
      { ruleId: 'java.x', fromFile: 'libs/a/src/main/java/X.java' },
    ];
    const result = filterViolationsToChangedScope(violations, {
      projectRoot: root,
      files: ['libs/a/src/main/java/X.java'],
    });
    expect(result.includedViolations).toHaveLength(1);
    rmSync(root, { recursive: true });
  });

  test('resolveChangedFiles returns Files mode when explicit list given', () => {
    const root = makeTempRepo('rcf');
    const r = resolveChangedFiles({ projectRoot: root, files: ['a.ts', 'b.ts'] });
    expect(r.mode).toBe(ChangedScopeMode.Files);
    expect(r.files).toEqual(['a.ts', 'b.ts']);
    rmSync(root, { recursive: true });
  });
});

describe('plugin lifecycle plans', () => {
  test('rename emits FEATURE_KEYS replace op + barrel update + manual folder rename', () => {
    const root = makeTempRepo('rename');
    mkdirSync(join(root, 'libs/demo/plugin/plugin-core/src/lib/types'), { recursive: true });
    writeFileSync(
      join(root, 'libs/demo/plugin/plugin-core/src/lib/types/FEATURE_KEYS.ts'),
      `export const FEATURE_KEYS = {\n  USER_CARD: 'userCard',\n  LAYOUT: 'layout',\n} as const;\n`,
    );
    mkdirSync(join(root, 'libs/demo/plugin/plugin-api/src/lib/plugins/layout'), { recursive: true });
    mkdirSync(join(root, 'libs/demo/plugin/plugin-api/src'), { recursive: true });
    writeFileSync(
      join(root, 'libs/demo/plugin/plugin-api/src/index.ts'),
      `export * from './lib/plugins/layout';\n`,
    );
    const plan = buildPluginRenamePlan({
      projectRoot: root,
      profile: DEMO_FIXTURE_PROFILE,
      oldName: 'layout',
      newName: 'table-viewport-layout',
    });
    expect(plan.destructive).toBe(true);
    expect(plan.humanApprovalRequired).toBe(true);
    const keyOp = plan.replaceOps.find((o) =>
      o.targetPath.includes('FEATURE_KEYS.ts'),
    );
    expect(keyOp).toBeDefined();
    expect(keyOp!.operation.replaceWith).toContain('TABLE_VIEWPORT_LAYOUT');
    expect(keyOp!.operation.replaceWith).toContain('tableViewportLayout');
    const barrelOp = plan.replaceOps.find((o) =>
      o.targetPath.includes('plugin-api/src/index.ts'),
    );
    expect(barrelOp).toBeDefined();
    const manual = plan.manualSteps.find((m) => m.kind === 'rename-folder');
    expect(manual).toBeDefined();
    expect(manual!.targetPath).toContain('plugins/layout');
    rmSync(root, { recursive: true });
  });

  test('remove plan emits FEATURE_KEYS remove + barrel removal + delete-folder manual step', () => {
    const root = makeTempRepo('remove');
    mkdirSync(join(root, 'libs/demo/plugin/plugin-core/src/lib/types'), { recursive: true });
    writeFileSync(
      join(root, 'libs/demo/plugin/plugin-core/src/lib/types/FEATURE_KEYS.ts'),
      `export const FEATURE_KEYS = {\n  STALE: 'stale',\n} as const;\n`,
    );
    mkdirSync(join(root, 'libs/demo/plugin/plugin-api/src/lib/plugins/stale'), { recursive: true });
    mkdirSync(join(root, 'libs/demo/plugin/plugin-api/src'), { recursive: true });
    writeFileSync(
      join(root, 'libs/demo/plugin/plugin-api/src/index.ts'),
      `export * from './lib/plugins/stale';\n`,
    );
    const plan = buildPluginRemovePlan({ projectRoot: root, profile: DEMO_FIXTURE_PROFILE, oldName: 'stale' });
    expect(plan.destructive).toBe(true);
    expect(plan.humanApprovalRequired).toBe(true);
    const keyOp = plan.replaceOps.find((o) => o.targetPath.includes('FEATURE_KEYS.ts'));
    expect(keyOp).toBeDefined();
    expect(keyOp!.operation.replaceWith).toBe('');
    const manual = plan.manualSteps.find((m) => m.kind === 'delete-folder');
    expect(manual).toBeDefined();
    rmSync(root, { recursive: true });
  });

  test('remove plan surfaces conflict when plugin is not registered', () => {
    const root = makeTempRepo('remove2');
    mkdirSync(join(root, 'libs/demo/plugin/plugin-core/src/lib/types'), { recursive: true });
    writeFileSync(
      join(root, 'libs/demo/plugin/plugin-core/src/lib/types/FEATURE_KEYS.ts'),
      `export const FEATURE_KEYS = {\n} as const;\n`,
    );
    const plan = buildPluginRemovePlan({ projectRoot: root, profile: DEMO_FIXTURE_PROFILE, oldName: 'ghost' });
    expect(plan.conflicts.some((c) => c.includes('ghost'))).toBe(true);
    rmSync(root, { recursive: true });
  });
});

describe('helper plan generators', () => {
  test('helper registry exposes 13 helpers', () => {
    expect(HELPERS.length).toBe(13);
  });

  test('add-plugin-key emits insert-before op (profile-driven)', () => {
    const root = makeTempRepo('hpk');
    const plan = buildHelperPlan({
      helperId: HelperId.AddPluginKey,
      projectRoot: root,
      vars: { key: 'user-card' },
      profile: DEMO_FIXTURE_PROFILE,
    });
    expect(plan.ops).toHaveLength(1);
    expect((plan.ops[0]!.operation as { kind: string }).kind).toBe('insert-before');
    expect((plan.ops[0]!.operation as { snippet: string }).snippet).toContain('USER_CARD');
    rmSync(root, { recursive: true });
  });

  test('add-barrel-export emits an export op', () => {
    const root = makeTempRepo('hbe');
    const plan = buildHelperPlan({
      helperId: HelperId.AddBarrelExport,
      projectRoot: root,
      vars: { barrel: 'libs/x/src/index.ts', from: './lib/foo' },
    });
    expect(plan.ops).toHaveLength(1);
    expect((plan.ops[0]!.operation as { kind: string }).kind).toBe('export');
    rmSync(root, { recursive: true });
  });

  test('remove-barrel-export reports conflict when no matching line', () => {
    const root = makeTempRepo('hbe2');
    mkdirSync(join(root, 'libs/x/src'), { recursive: true });
    writeFileSync(join(root, 'libs/x/src/index.ts'), `export * from './lib/other';\n`);
    const plan = buildHelperPlan({
      helperId: HelperId.RemoveBarrelExport,
      projectRoot: root,
      vars: { barrel: 'libs/x/src/index.ts', from: './lib/missing' },
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.destructive).toBe(true);
    expect(plan.humanReviewRequired).toBe(true);
    rmSync(root, { recursive: true });
  });

  test('missing required variable throws', () => {
    const root = makeTempRepo('hbv');
    expect(() =>
      buildHelperPlan({ helperId: HelperId.AddPluginKey, projectRoot: root, vars: {} }),
    ).toThrow();
    rmSync(root, { recursive: true });
  });
});

describe('pack dev-status', () => {
  test('detects source layout', () => {
    const root = makeTempRepo('pack');
    mkdirSync(join(root, 'src/assets'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@test/pack', version: '1.0.0' }),
    );
    writeFileSync(join(root, 'src/assets/rules.ts'), `export default [];\n`);
    const status = buildPackDevStatus({ packPath: root });
    expect(status.packExists).toBe(true);
    expect(status.packVersion).toBe('1.0.0');
    expect(status.signatureStaleness).toBe('missing');
    rmSync(root, { recursive: true });
  });

  test('detects stale signature when asset is newer', async () => {
    const root = makeTempRepo('pack2');
    mkdirSync(join(root, 'src/assets'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@test/pack', version: '1.0.0' }),
    );
    writeFileSync(join(root, 'sharkcraft.plugin.signed.json'), `{}`);
    // Ensure asset mtime is greater than signature.
    await new Promise((r) => setTimeout(r, 1100));
    writeFileSync(join(root, 'src/assets/rules.ts'), `export default [];\n`);
    const status = buildPackDevStatus({ packPath: root });
    expect(status.signatureStaleness).toBe('stale');
    expect(status.staleAssets.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true });
  });
});

describe('registry lifecycle scanner', () => {
  test('flags register without remove', () => {
    const root = makeTempRepo('rlc');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src/foo.ts'),
      `export function registerFoo() {}\n`,
    );
    const r = buildRegistryLifecycleReport({ projectRoot: root });
    expect(r.missingRemovers.find((m) => m.registerName === 'registerFoo')).toBeDefined();
    rmSync(root, { recursive: true });
  });

  test('matches register/remove pair', () => {
    const root = makeTempRepo('rlc2');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src/foo.ts'),
      `export function registerFoo() {}\nexport function removeFoo() {}\n`,
    );
    const r = buildRegistryLifecycleReport({ projectRoot: root });
    expect(r.matchedPairs.find((p) => p.registerName === 'registerFoo')).toBeDefined();
    rmSync(root, { recursive: true });
  });

  test('respects @shrkcrft lifecycle-ignore annotation', () => {
    const root = makeTempRepo('rlc3');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src/foo.ts'),
      `// @shrkcrft lifecycle-ignore process-lifetime\nexport function registerFoo() {}\n`,
    );
    const r = buildRegistryLifecycleReport({ projectRoot: root });
    expect(r.ignored.find((i) => i.registerName === 'registerFoo')).toBeDefined();
    expect(r.missingRemovers.find((m) => m.registerName === 'registerFoo')).toBeUndefined();
    rmSync(root, { recursive: true });
  });
});

describe('pack test runner', () => {
  test('reports no tests when pack-tests file is absent', async () => {
    const root = makeTempRepo('ptr');
    const r = await runPackTests({ packPath: root });
    expect(r.ran).toBe(0);
    expect(r.testsFile).toBe(null);
    rmSync(root, { recursive: true });
  });
});

describe('ingest body extractor', () => {
  test('skips when draft file is absent', () => {
    const root = makeTempRepo('ibe');
    const r = extractIngestBody({
      projectRoot: root,
      target: 'sharkcraft/rules.ts',
      entryId: 'some.id',
    });
    expect(r.status).toBe('skipped');
    rmSync(root, { recursive: true });
  });

  test('materialises an entry body from a draft file', () => {
    const root = makeTempRepo('ibe2');
    mkdirSync(join(root, 'sharkcraft/ingestion/generated'), { recursive: true });
    writeFileSync(
      join(root, 'sharkcraft/ingestion/generated/rules.draft.ts'),
      `export default [\n  { id: 'foo.bar', message: 'hello' },\n];\n`,
    );
    const r = extractIngestBody({
      projectRoot: root,
      target: 'sharkcraft/rules.ts',
      entryId: 'foo.bar',
    });
    expect(r.status).toBe('materialised');
    expect(r.body).toContain('foo.bar');
    expect(r.body).toContain('hello');
    rmSync(root, { recursive: true });
  });

  test('reports conflict when entry id matches more than once', () => {
    const root = makeTempRepo('ibe3');
    mkdirSync(join(root, 'sharkcraft/ingestion/generated'), { recursive: true });
    writeFileSync(
      join(root, 'sharkcraft/ingestion/generated/rules.draft.ts'),
      `export default [\n  { id: 'foo.bar', a: 1 },\n  { id: 'foo.bar', a: 2 },\n];\n`,
    );
    const r = extractIngestBody({
      projectRoot: root,
      target: 'sharkcraft/rules.ts',
      entryId: 'foo.bar',
    });
    expect(r.status).toBe('conflict');
    rmSync(root, { recursive: true });
  });
});

describe('language runner allowlist policy', () => {
  test('built-in deny pattern always wins', () => {
    const root = makeTempRepo('lrp');
    const decision = explainCommandPolicy('npm publish', root);
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('builtin-deny');
    rmSync(root, { recursive: true });
  });

  test('config allow rule permits a safe custom command', () => {
    const root = makeTempRepo('lrp2');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(
      join(root, 'sharkcraft/runner.allowlist.json'),
      JSON.stringify({
        allow: [{ id: 'python.pytest', command: 'python -m pytest', reason: 'local tests' }],
        deny: [],
      }),
    );
    const decision = explainCommandPolicy('python -m pytest', root);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('config-allow');
    const policy = getLanguageRunnerPolicy(root);
    expect(policy.allow).toHaveLength(1);
    rmSync(root, { recursive: true });
  });

  test('config deny pattern blocks even when listed in allow', () => {
    const root = makeTempRepo('lrp3');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(
      join(root, 'sharkcraft/runner.allowlist.json'),
      JSON.stringify({
        allow: [],
        deny: [{ pattern: 'rm\\s+-rf', reason: 'no destructive cleanup' }],
      }),
    );
    const decision = explainCommandPolicy('rm -rf node_modules', root);
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('config-deny');
    rmSync(root, { recursive: true });
  });

  test('built-in deny cannot be bypassed by allow rule', () => {
    const root = makeTempRepo('lrp4');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(
      join(root, 'sharkcraft/runner.allowlist.json'),
      JSON.stringify({
        allow: [{ id: 'sneaky', command: 'sudo bash', reason: 'i mean well' }],
        deny: [],
      }),
    );
    const decision = explainCommandPolicy('sudo bash', root);
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('builtin-deny');
    rmSync(root, { recursive: true });
  });
});
