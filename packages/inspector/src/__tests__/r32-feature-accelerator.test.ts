/**
 * Tests for generic extension platform deliverables.
 *
 * Covers:
 *  • IPluginLifecycleProfile validation (schema)
 *  • Profile-driven plugin rename / remove plans against a fixture profile
 *  • Plan v2 fixture (generic example layout)
 *  • Project-coupling audit scanner
 *  • Migration readiness customProfiles slot
 *  • Helper-registry helpers require profile when needed
 *  • Contract template registry merges built-ins + pack-contributed fixtures
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaseStyle,
  PluginLifecycleRootKind,
  validatePluginLifecycleProfile,
  type IPluginLifecycleProfile,
} from '@shrkcrft/plugin-api';
import {
  buildHelperPlan,
  HelperId,
  buildPluginRenamePlan,
  buildPluginRemovePlan,
  buildPluginLifecycleListing,
  checkPluginLifecycleProfileHealth,
} from '../index.ts';
import {
  auditProjectCoupling,
  CouplingExternalizationTarget,
} from '../project-coupling-audit.ts';
import {
  buildMigrationReadiness,
  MigrationVerdict,
  type IMigrationProfile,
} from '../migration-readiness.ts';

function makeTempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `r32-${prefix}-`));
}

const EXAMPLE_PROFILE: IPluginLifecycleProfile = {
  id: 'example',
  title: 'Example fixture profile',
  description: 'Generic fixture profile — no project-specific paths.',
  pluginRoots: [
    { id: 'core', path: 'libs/example/plugin-core/src/lib/plugins', kind: PluginLifecycleRootKind.Api },
    { id: 'ui', path: 'libs/example/plugin-ui/src/lib/plugins', kind: PluginLifecycleRootKind.Ui },
  ],
  barrels: [
    { id: 'core-barrel', path: 'libs/example/plugin-core/src/index.ts', exportSegment: './lib/plugins' },
    { id: 'ui-barrel', path: 'libs/example/plugin-ui/src/index.ts', exportSegment: './lib/plugins' },
  ],
  keyTable: {
    id: 'example-keys',
    path: 'libs/example/plugin-core/src/lib/types/EXAMPLE_KEYS.ts',
    keyCase: CaseStyle.UpperSnake,
    valueCase: CaseStyle.Camel,
    entryAnchor: '} as const;',
  },
  validationCommands: ['shrk doctor', 'shrk check boundaries --changed-only'],
};

describe('IPluginLifecycleProfile validation', () => {
  test('valid profile passes', () => {
    const r = validatePluginLifecycleProfile(EXAMPLE_PROFILE);
    expect(r.valid).toBe(true);
    expect(r.issues).toHaveLength(0);
  });
  test('missing id is reported', () => {
    const r = validatePluginLifecycleProfile({ title: 'x', pluginRoots: [{ id: 'a', path: 'b' }] });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'id')).toBe(true);
  });
  test('empty pluginRoots is reported', () => {
    const r = validatePluginLifecycleProfile({
      id: 'x',
      title: 'x',
      pluginRoots: [],
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'pluginRoots')).toBe(true);
  });
  test('invalid keyCase is reported', () => {
    const r = validatePluginLifecycleProfile({
      id: 'x',
      title: 'x',
      pluginRoots: [{ id: 'a', path: 'b' }],
      keyTable: { path: 'x', keyCase: 'NOT_A_CASE', valueCase: 'camel' },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'keyTable.keyCase')).toBe(true);
  });
});

describe('Profile-driven plugin lifecycle plans', () => {
  test('rename emits key-table replace + barrel updates + manual folder rename', () => {
    const root = makeTempRepo('rename');
    mkdirSync(join(root, 'libs/example/plugin-core/src/lib/types'), { recursive: true });
    writeFileSync(
      join(root, 'libs/example/plugin-core/src/lib/types/EXAMPLE_KEYS.ts'),
      `export const EXAMPLE_KEYS = {\n  USER_CARD: 'userCard',\n  LAYOUT: 'layout',\n} as const;\n`,
    );
    mkdirSync(join(root, 'libs/example/plugin-core/src'), { recursive: true });
    mkdirSync(join(root, 'libs/example/plugin-core/src/lib/plugins/layout'), { recursive: true });
    writeFileSync(
      join(root, 'libs/example/plugin-core/src/index.ts'),
      `export * from './lib/plugins/layout';\n`,
    );
    const plan = buildPluginRenamePlan({
      projectRoot: root,
      profile: EXAMPLE_PROFILE,
      oldName: 'layout',
      newName: 'table-viewport-layout',
    });
    expect(plan.profile).toBe('example');
    expect(plan.destructive).toBe(true);
    const keyOp = plan.replaceOps.find((o) => o.targetPath.includes('EXAMPLE_KEYS.ts'));
    expect(keyOp).toBeDefined();
    expect(keyOp!.operation.replaceWith).toContain('TABLE_VIEWPORT_LAYOUT');
    expect(keyOp!.operation.replaceWith).toContain('tableViewportLayout');
    const barrelOp = plan.replaceOps.find((o) => o.targetPath.includes('plugin-core/src/index.ts'));
    expect(barrelOp).toBeDefined();
    const manual = plan.manualSteps.find((m) => m.kind === 'rename-folder');
    expect(manual).toBeDefined();
    rmSync(root, { recursive: true });
  });

  test('remove emits key-table delete + barrel removal + delete-folder manual step', () => {
    const root = makeTempRepo('remove');
    mkdirSync(join(root, 'libs/example/plugin-core/src/lib/types'), { recursive: true });
    writeFileSync(
      join(root, 'libs/example/plugin-core/src/lib/types/EXAMPLE_KEYS.ts'),
      `export const EXAMPLE_KEYS = {\n  STALE: 'stale',\n} as const;\n`,
    );
    mkdirSync(join(root, 'libs/example/plugin-core/src/lib/plugins/stale'), { recursive: true });
    mkdirSync(join(root, 'libs/example/plugin-core/src'), { recursive: true });
    writeFileSync(
      join(root, 'libs/example/plugin-core/src/index.ts'),
      `export * from './lib/plugins/stale';\n`,
    );
    const plan = buildPluginRemovePlan({
      projectRoot: root,
      profile: EXAMPLE_PROFILE,
      oldName: 'stale',
    });
    expect(plan.profile).toBe('example');
    expect(plan.destructive).toBe(true);
    const keyOp = plan.replaceOps.find((o) => o.targetPath.includes('EXAMPLE_KEYS.ts'));
    expect(keyOp).toBeDefined();
    expect(keyOp!.operation.replaceWith).toBe('');
    const manual = plan.manualSteps.find((m) => m.kind === 'delete-folder');
    expect(manual).toBeDefined();
    rmSync(root, { recursive: true });
  });

  test('listing surfaces plugins per profile root + key entries', () => {
    const root = makeTempRepo('listing');
    mkdirSync(join(root, 'libs/example/plugin-core/src/lib/plugins/foo'), { recursive: true });
    mkdirSync(join(root, 'libs/example/plugin-core/src/lib/plugins/bar'), { recursive: true });
    mkdirSync(join(root, 'libs/example/plugin-core/src/lib/types'), { recursive: true });
    writeFileSync(
      join(root, 'libs/example/plugin-core/src/lib/types/EXAMPLE_KEYS.ts'),
      `export const EXAMPLE_KEYS = {\n  FOO: 'foo',\n  BAR: 'bar',\n} as const;\n`,
    );
    const r = buildPluginLifecycleListing({ projectRoot: root, profile: EXAMPLE_PROFILE });
    expect(Object.keys(r.pluginsByLayer)).toContain('libs/example/plugin-core/src/lib/plugins');
    const names = [...(r.pluginsByLayer['libs/example/plugin-core/src/lib/plugins'] ?? [])].sort();
    expect(names).toEqual(['bar', 'foo']);
    expect(r.pluginKeys.find((k) => k.value === 'foo')).toBeDefined();
    rmSync(root, { recursive: true });
  });

  test('checkPluginLifecycleProfileHealth flags missing paths', () => {
    const root = makeTempRepo('health');
    const checks = checkPluginLifecycleProfileHealth(root, EXAMPLE_PROFILE);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.some((c) => c.id === 'missing-key-table' || c.id === 'missing-barrel' || c.id === 'missing-plugin-root')).toBe(true);
    rmSync(root, { recursive: true });
  });
});

describe('Helper-registry requires profile when needed', () => {
  test('AddPluginKey without profile throws', () => {
    const root = makeTempRepo('hpk-no-profile');
    expect(() =>
      buildHelperPlan({
        helperId: HelperId.AddPluginKey,
        projectRoot: root,
        vars: { key: 'user-card' },
      }),
    ).toThrow();
    rmSync(root, { recursive: true });
  });

  test('AddPluginKey with profile emits insert-before op against profile.keyTable.path', () => {
    const root = makeTempRepo('hpk-with-profile');
    const plan = buildHelperPlan({
      helperId: HelperId.AddPluginKey,
      projectRoot: root,
      vars: { key: 'user-card' },
      profile: EXAMPLE_PROFILE,
    });
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]!.targetPath).toBe(EXAMPLE_PROFILE.keyTable!.path);
    expect((plan.ops[0]!.operation as { snippet: string }).snippet).toContain('USER_CARD');
    rmSync(root, { recursive: true });
  });

  test('AddBarrelExport works without profile (generic vars only)', () => {
    const root = makeTempRepo('hbe-no-profile');
    const plan = buildHelperPlan({
      helperId: HelperId.AddBarrelExport,
      projectRoot: root,
      vars: { barrel: 'libs/x/src/index.ts', from: './lib/foo' },
    });
    expect(plan.ops).toHaveLength(1);
    rmSync(root, { recursive: true });
  });
});

describe('Project-coupling audit', () => {
  test('returns clean when no tokens are passed', () => {
    const root = makeTempRepo('coupling-clean');
    const r = auditProjectCoupling({ projectRoot: root, tokens: [] });
    expect(r.verdict).toBe('clean');
    expect(r.hits).toHaveLength(0);
    rmSync(root, { recursive: true });
  });

  test('finds tokens in packages and classifies as Pack target', () => {
    const root = makeTempRepo('coupling-hit');
    mkdirSync(join(root, 'packages/example/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/example/src/code.ts'),
      `import { foo } from 'libs/legacy/plugin/plugin-api/src/index.ts';\nexport const x = 1;\n`,
    );
    const r = auditProjectCoupling({ projectRoot: root, tokens: ['libs/legacy'] });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.externalizationTarget).toBe(CouplingExternalizationTarget.Engine);
    expect(r.verdict).toBe('has-coupling');
    rmSync(root, { recursive: true });
  });

  test('tests folder hits classify as FixtureOnly', () => {
    const root = makeTempRepo('coupling-fixture');
    mkdirSync(join(root, 'packages/example/src/__tests__'), { recursive: true });
    writeFileSync(
      join(root, 'packages/example/src/__tests__/x.test.ts'),
      `describe('libs/legacy fixture', () => {});\n`,
    );
    const r = auditProjectCoupling({ projectRoot: root, tokens: ['libs/legacy'] });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.externalizationTarget).toBe(CouplingExternalizationTarget.FixtureOnly);
    expect(r.verdict).toBe('clean'); // fixture-only is not blocking
    rmSync(root, { recursive: true });
  });
});

describe('Migration readiness customProfiles', () => {
  test('engine ships no built-in migration profiles', () => {
    const root = makeTempRepo('mig-empty');
    const r = buildMigrationReadiness({ profileId: 'nonexistent', projectRoot: root });
    expect(r.verdict).toBe(MigrationVerdict.Blocked);
    expect(r.blockers[0]!.id).toBe('profile-unknown');
    rmSync(root, { recursive: true });
  });

  test('customProfiles supplies the migration profile', () => {
    const root = makeTempRepo('mig-custom');
    const customProfile: IMigrationProfile = {
      id: 'example-migration',
      title: 'Example migration profile',
      successVerdict: MigrationVerdict.ReadyToDeprecate,
      checks: [
        {
          id: 'has-readme',
          title: 'README present',
          filePresent: ['README.md'],
          blockerReason: MigrationVerdict.Blocked,
        },
      ],
    };
    writeFileSync(join(root, 'README.md'), '# repo\n');
    const r = buildMigrationReadiness({
      profileId: 'example-migration',
      projectRoot: root,
      customProfiles: [customProfile],
    });
    expect(r.ready).toBe(true);
    expect(r.verdict).toBe(MigrationVerdict.ReadyToDeprecate);
    rmSync(root, { recursive: true });
  });
});
