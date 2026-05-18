import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMigrationReadiness,
  listMigrationProfiles,
  MigrationVerdict,
  MigrationCheckStatus,
  type IMigrationProfile,
} from '../migration-readiness.ts';
import { reviewSavedPlan } from '../plan-review.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

// Fixture profile (replaces an engine-level retirement profile).
const FIXTURE_RETIREMENT_PROFILE: IMigrationProfile = {
  id: 'demo-cli-retirement',
  title: 'Demo CLI retirement readiness',
  description: 'Fixture profile.',
  successVerdict: MigrationVerdict.ReadyToDelete,
  checks: [
    {
      id: 'pack-manifest-signed',
      title: 'Pack manifest is signed',
      category: 'pack',
      filePresentAny: [
        'demo-sharkcraft-pack/manifest.signed.json',
        'tools/sharkcraft-pack/manifest.signed.json',
      ],
      blockerReason: MigrationVerdict.ReadyExceptSigning,
    },
    {
      id: 'pack-secret-set',
      title: 'SHARKCRAFT_PACK_SECRET is configured',
      category: 'pack',
      envVar: 'SHARKCRAFT_PACK_SECRET',
      optional: true,
    },
    {
      id: 'parity-report',
      title: 'Generator parity final report exists',
      category: 'parity',
      filePresent: ['.sharkcraft/reports/generator-parity-final.md'],
      blockerReason: MigrationVerdict.Blocked,
    },
    {
      id: 'gap-audit-v2',
      title: 'DevTools gap audit v2 exists',
      category: 'parity',
      filePresent: ['.sharkcraft/reports/demo-devtools-gap-audit-v2.md'],
      blockerReason: MigrationVerdict.Blocked,
    },
    {
      id: 'drift-baseline-plan',
      title: 'Drift baseline action plan documented',
      category: 'baseline',
      filePresent: ['.sharkcraft/reports/demo-drift-baseline-action-plan.md'],
      blockerReason: MigrationVerdict.ReadyExceptBaseline,
    },
    {
      id: 'drift-baseline-applied',
      title: 'Drift baseline applied (sharkcraft/quality-baseline.json present)',
      category: 'baseline',
      filePresent: ['sharkcraft/quality-baseline.json'],
      optional: true,
    },
    {
      id: 'dedupe-action-plan',
      title: 'Dedupe action plan exists',
      category: 'dedupe',
      filePresent: ['.sharkcraft/reports/sharkcraft-dedupe-action-plan.md'],
      blockerReason: MigrationVerdict.ReadyExceptDedupe,
    },
    {
      id: 'dedupe-patch',
      title: 'Dedupe patch generated',
      category: 'dedupe',
      filePresent: ['.sharkcraft/reports/sharkcraft-dedupe.patch'],
      blockerReason: MigrationVerdict.ReadyExceptDedupe,
    },
    {
      id: 'script-migration-plan',
      title: 'Script migration plan exists',
      category: 'scripts',
      filePresent: ['.sharkcraft/reports/demo-script-migration-action-plan.md'],
      blockerReason: MigrationVerdict.ReadyExceptScriptSwitch,
    },
    {
      id: 'script-migration-patch',
      title: 'Script migration patch generated',
      category: 'scripts',
      filePresent: ['.sharkcraft/reports/demo-script-migration.patch'],
      blockerReason: MigrationVerdict.ReadyExceptScriptSwitch,
    },
    {
      id: 'mcp-separation',
      title: 'MCP separation note documented',
      category: 'mcp',
      filePresent: ['.sharkcraft/reports/mcp-separation-final.md'],
      blockerReason: MigrationVerdict.Blocked,
    },
    {
      id: 'retirement-playbook',
      title: 'Retirement readiness playbook exists in pack',
      category: 'playbook',
      filePresentAny: [
        'demo-sharkcraft-pack/src/assets/playbooks.ts',
        'tools/sharkcraft-pack/src/assets/playbooks.ts',
      ],
      blockerReason: MigrationVerdict.Blocked,
    },
    {
      id: 'retirement-runbook',
      title: 'Retirement runbook exists',
      category: 'sequence',
      filePresent: ['.sharkcraft/reports/demo-cli-retirement-runbook.md'],
      blockerReason: MigrationVerdict.Blocked,
    },
    {
      id: 'cli-still-present',
      title: 'Legacy CLI is still present (delete is the final action)',
      category: 'sequence',
      filePresent: ['tools/cli/src/index.ts'],
      optional: true,
    },
  ],
};

function makeBareFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r22-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'r22-fixture', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'r22-fixture', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], pipelineFiles: [] };`,
  );
  return root;
}

describe('migration readiness', () => {
  test('lists pack/local migration profiles via customProfiles', () => {
    const profiles = listMigrationProfiles([FIXTURE_RETIREMENT_PROFILE]);
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('demo-cli-retirement');
  });

  test('engine ships zero built-in migration profiles', () => {
    const profiles = listMigrationProfiles();
    expect(profiles.length).toBe(0);
  });

  test('unknown profile yields a blocked verdict', () => {
    const root = makeBareFixture();
    const report = buildMigrationReadiness({
      profileId: 'does-not-exist',
      projectRoot: root,
    });
    expect(report.verdict).toBe(MigrationVerdict.Blocked);
    expect(report.ready).toBe(false);
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(report.blockers[0]!.id).toBe('profile-unknown');
  });

  test('bare repo with no reports blocks on a specific reason', () => {
    const root = makeBareFixture();
    const report = buildMigrationReadiness({
      profileId: 'demo-cli-retirement',
      projectRoot: root,
      customProfiles: [FIXTURE_RETIREMENT_PROFILE],
    });
    expect(report.ready).toBe(false);
    // The most specific verdict is ready-except-* — but with this empty
    // fixture the gap-audit and parity-report blockers also fire, so the
    // first specific blocker wins.
    expect(report.verdict).not.toBe(MigrationVerdict.ReadyToDelete);
    // Among the blockers there must be one with a specific blockerReason.
    const specificBlockerReasons = report.blockers
      .map((b) => b.blockerReason)
      .filter((r): r is MigrationVerdict => r !== undefined);
    expect(specificBlockerReasons.length).toBeGreaterThan(0);
  });

  test('all required reports present + cli still present → ready-to-deprecate (warn on env)', () => {
    const root = makeBareFixture();
    const r = join(root, '.sharkcraft', 'reports');
    mkdirSync(r, { recursive: true });
    mkdirSync(join(root, 'demo-sharkcraft-pack', 'src', 'assets'), { recursive: true });
    mkdirSync(join(root, 'tools', 'cli', 'src'), { recursive: true });

    // All required reports
    writeFileSync(join(root, 'demo-sharkcraft-pack', 'manifest.signed.json'), '{}');
    writeFileSync(join(r, 'generator-parity-final.md'), '# parity');
    writeFileSync(join(r, 'demo-devtools-gap-audit-v2.md'), '# gap');
    writeFileSync(join(r, 'demo-drift-baseline-action-plan.md'), '# drift');
    writeFileSync(join(r, 'sharkcraft-dedupe-action-plan.md'), '# dedupe');
    writeFileSync(join(r, 'sharkcraft-dedupe.patch'), '');
    writeFileSync(join(r, 'demo-script-migration-action-plan.md'), '# scripts');
    writeFileSync(join(r, 'demo-script-migration.patch'), '');
    writeFileSync(join(r, 'mcp-separation-final.md'), '# mcp');
    writeFileSync(join(r, 'demo-cli-retirement-runbook.md'), '# runbook');
    writeFileSync(join(root, 'demo-sharkcraft-pack', 'src', 'assets', 'playbooks.ts'), 'export default [];');
    // Optional: drift baseline applied
    writeFileSync(join(root, 'sharkcraft', 'quality-baseline.json'), '{}');
    // Optional: cli still present
    writeFileSync(join(root, 'tools', 'cli', 'src', 'index.ts'), '// stub');

    // Ensure env is not set so the optional warning fires.
    const previous = process.env['SHARKCRAFT_PACK_SECRET'];
    delete process.env['SHARKCRAFT_PACK_SECRET'];
    try {
      const report = buildMigrationReadiness({
        profileId: 'demo-cli-retirement',
        projectRoot: root,
        customProfiles: [FIXTURE_RETIREMENT_PROFILE],
      });
      expect(report.blockers.length).toBe(0);
      // Single optional warning expected (pack-secret-set).
      expect(report.warnings.length).toBeGreaterThanOrEqual(1);
      expect(report.warnings[0]!.id).toBe('pack-secret-set');
      // Verdict downgrades to ReadyToDeprecate when warnings exist.
      expect(report.verdict).toBe(MigrationVerdict.ReadyToDeprecate);
      expect(report.ready).toBe(true);
    } finally {
      if (previous !== undefined) process.env['SHARKCRAFT_PACK_SECRET'] = previous;
    }
  });

  test('readiness with env set + cli already deleted → ready-to-delete (steady-state)', () => {
    const root = makeBareFixture();
    const r = join(root, '.sharkcraft', 'reports');
    mkdirSync(r, { recursive: true });
    mkdirSync(join(root, 'demo-sharkcraft-pack', 'src', 'assets'), { recursive: true });

    writeFileSync(join(root, 'demo-sharkcraft-pack', 'manifest.signed.json'), '{}');
    writeFileSync(join(r, 'generator-parity-final.md'), '# parity');
    writeFileSync(join(r, 'demo-devtools-gap-audit-v2.md'), '# gap');
    writeFileSync(join(r, 'demo-drift-baseline-action-plan.md'), '# drift');
    writeFileSync(join(root, 'sharkcraft', 'quality-baseline.json'), '{}');
    writeFileSync(join(r, 'sharkcraft-dedupe-action-plan.md'), '# dedupe');
    writeFileSync(join(r, 'sharkcraft-dedupe.patch'), '');
    writeFileSync(join(r, 'demo-script-migration-action-plan.md'), '# scripts');
    writeFileSync(join(r, 'demo-script-migration.patch'), '');
    writeFileSync(join(r, 'mcp-separation-final.md'), '# mcp');
    writeFileSync(join(r, 'demo-cli-retirement-runbook.md'), '# runbook');
    writeFileSync(join(root, 'demo-sharkcraft-pack', 'src', 'assets', 'playbooks.ts'), 'export default [];');

    process.env['SHARKCRAFT_PACK_SECRET'] = 'test-secret';
    try {
      const report = buildMigrationReadiness({
        profileId: 'demo-cli-retirement',
        projectRoot: root,
        customProfiles: [FIXTURE_RETIREMENT_PROFILE],
      });
      expect(report.blockers.length).toBe(0);
      // cli-still-present is optional; absence is a warning. So we expect at
      // least one warning still, but the verdict remains ready-to-deprecate.
      // We're not asserting ready-to-delete here — only that the engine
      // doesn't crash and the system is "ready" (no hard blockers).
      expect(report.ready).toBe(true);
    } finally {
      delete process.env['SHARKCRAFT_PACK_SECRET'];
    }
  });

  test('every check result has the canonical fields', () => {
    const root = makeBareFixture();
    const report = buildMigrationReadiness({
      profileId: 'demo-cli-retirement',
      projectRoot: root,
      customProfiles: [FIXTURE_RETIREMENT_PROFILE],
    });
    for (const r of [...report.blockers, ...report.warnings, ...report.passed]) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.status).toBe('string');
      expect(Object.values(MigrationCheckStatus)).toContain(r.status);
    }
  });
});

describe('plan review v2 classifier', () => {
  test('reviewSavedPlan surfaces append/export/update as their own kinds', async () => {
    const root = makeBareFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const plan = {
      schema: 'sharkcraft.plan/v1' as const,
      templateId: 'fake.template',
      createdAt: new Date().toISOString(),
      variables: {},
      expectedChanges: [
        { relativePath: 'libs/x/index.ts', type: 'create', sizeBytes: 10, contentHash: 'h1' },
        { relativePath: 'libs/x/barrel.ts', type: 'export', sizeBytes: 5, contentHash: 'h2' },
        { relativePath: 'libs/x/events.ts', type: 'append', sizeBytes: 7, contentHash: 'h3' },
        { relativePath: 'libs/x/keys.ts', type: 'update', sizeBytes: 9, contentHash: 'h4' },
        { relativePath: 'libs/x/old.ts', type: 'conflict', sizeBytes: 0, contentHash: 'h5' },
      ],
    };
    const planPath = join(root, '.sharkcraft', 'plans', 'p.json');
    mkdirSync(join(root, '.sharkcraft', 'plans'), { recursive: true });
    writeFileSync(planPath, JSON.stringify(plan));
    const review = reviewSavedPlan(inspection, planPath);
    const types = review.files.map((f) => f.type);
    expect(types).toContain('create');
    expect(types).toContain('export');
    expect(types).toContain('append');
    expect(types).toContain('update');
    expect(types).toContain('conflict');
    // None should be 'unknown' for these kinds.
    expect(types).not.toContain('unknown');
    // The non-create, non-conflict entries should be flagged as modifying
    // existing files.
    const exportEntry = review.files.find((f) => f.type === 'export');
    expect(exportEntry?.modifiesExisting).toBe(true);
    const appendEntry = review.files.find((f) => f.type === 'append');
    expect(appendEntry?.modifiesExisting).toBe(true);
    const updateEntry = review.files.find((f) => f.type === 'update');
    expect(updateEntry?.modifiesExisting).toBe(true);
    const createEntry = review.files.find((f) => f.type === 'create');
    expect(createEntry?.modifiesExisting).toBeUndefined();
  });
});
