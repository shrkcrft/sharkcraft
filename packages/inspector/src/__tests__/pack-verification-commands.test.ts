import { describe, expect, test } from 'bun:test';
import { PackageManager } from '@shrkcrft/workspace';
import { PipelineStepType } from '@shrkcrft/pipelines';
import { resolveVerificationCommands } from '../resolve-verification-commands.ts';
import { buildPackDoctorReport } from '../pack-doctor.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

// ─── Part 1: templating (resolveVerificationCommands) ────────────────────────

function resolveStub(opts: {
  manager?: PackageManager;
  hasBunProfile?: boolean;
  pipelines?: Record<string, { steps: unknown[] }>;
  verificationCommands?: { id: string; command: string }[];
}): ISharkcraftInspection {
  return {
    workspace:
      opts.manager === undefined && !opts.hasBunProfile
        ? undefined
        : {
            packageManager: { manager: opts.manager ?? PackageManager.Unknown },
            profiles: opts.hasBunProfile ? ['has-bun'] : [],
          },
    pipelineRegistry: { get: (id: string) => opts.pipelines?.[id] ?? undefined },
    config: opts.verificationCommands ? { verificationCommands: opts.verificationCommands } : null,
  } as unknown as ISharkcraftInspection;
}

describe('resolveVerificationCommands — <pm> templating', () => {
  test('<pm-run> resolves to the detected manager run-prefix (config source)', () => {
    const cases: Array<[PackageManager, string]> = [
      [PackageManager.Bun, 'bun run test'],
      [PackageManager.Npm, 'npm run test'],
      [PackageManager.Pnpm, 'pnpm test'],
      [PackageManager.Yarn, 'yarn test'],
    ];
    for (const [manager, expected] of cases) {
      const inspection = resolveStub({
        manager,
        verificationCommands: [{ id: 'v', command: '<pm-run> test' }],
      });
      expect(resolveVerificationCommands(inspection, {})).toEqual([expected]);
    }
  });

  test('<pm> resolves to the bare manager name', () => {
    const inspection = resolveStub({
      manager: PackageManager.Pnpm,
      verificationCommands: [{ id: 'v', command: '<pm> test' }],
    });
    expect(resolveVerificationCommands(inspection, {})).toEqual(['pnpm test']);
  });

  test('a templated pipeline gate survives the placeholder-exclusion check', () => {
    const inspection = resolveStub({
      manager: PackageManager.Npm,
      pipelines: {
        'pack.ci': {
          steps: [
            { id: 'gate', type: PipelineStepType.Command, required: true, cliCommands: ['<pm-run> test'] },
            // truly generative step still excluded
            { id: 'spec', type: PipelineStepType.Command, required: true, cliCommands: ['shrk spec "<task>"'] },
          ],
        },
      },
    });
    expect(resolveVerificationCommands(inspection, { pipelineIds: ['pack.ci'] })).toEqual([
      'npm run test',
    ]);
  });

  test('falls back to the HasBun profile when no lockfile / packageManager field', () => {
    const inspection = resolveStub({
      hasBunProfile: true,
      verificationCommands: [{ id: 'v', command: '<pm-run> test' }],
    });
    expect(resolveVerificationCommands(inspection, {})).toEqual(['bun run test']);
  });

  test('substitution is applied to knowledge defaults too', () => {
    const inspection = resolveStub({ manager: PackageManager.Yarn });
    expect(
      resolveVerificationCommands(inspection, { knowledgeDefaults: ['<pm> lint'] }),
    ).toEqual(['yarn lint']);
  });

  test('non-templated commands are unchanged even without a workspace (backward compat)', () => {
    const inspection = resolveStub({ verificationCommands: [{ id: 'v', command: 'make verify' }] });
    expect(resolveVerificationCommands(inspection, {})).toEqual(['make verify']);
  });
});

// ─── Part 2: lint (buildPackDoctorReport) ────────────────────────────────────

function doctorStub(opts: {
  manager: PackageManager;
  packageName?: string;
  knowledgeVerification?: string[];
  pipelineGate?: string;
}): ISharkcraftInspection {
  const packageName = opts.packageName ?? '@acme/web-pack';
  const knowledgeEntries = opts.knowledgeVerification
    ? [{ id: 'acme.deploy', actionHints: { verificationCommands: opts.knowledgeVerification } }]
    : [];
  const pipelines = opts.pipelineGate
    ? [
        {
          id: 'acme.ci',
          steps: [
            { id: 'gate', type: PipelineStepType.Command, required: true, cliCommands: [opts.pipelineGate] },
          ],
        },
      ]
    : [];
  return {
    workspace: { packageManager: { manager: opts.manager }, profiles: [] },
    knowledgeEntries,
    entrySources: new Map(knowledgeEntries.map((e) => [e.id, { type: 'pack', packageName }])),
    templates: [],
    templateSources: new Map(),
    pipelines,
    pipelineSources: new Map(pipelines.map((p) => [p.id, { type: 'pack', packageName }])),
    presetRegistry: { list: () => [] },
    presetSources: new Map(),
    ruleService: { list: () => [] },
    pathService: { list: () => [] },
    warnings: [],
    packs: {
      invalidPacks: [],
      discoveredPacks: [
        { valid: true, packageName, manifest: { contributions: {} }, resolvedCounts: undefined },
      ],
    },
  } as unknown as ISharkcraftInspection;
}

const mismatchIssues = (inspection: ISharkcraftInspection) =>
  buildPackDoctorReport(inspection).issues.filter(
    (i) => i.code === 'pack-verification-pm-mismatch',
  );

describe('buildPackDoctorReport — foreign package-manager lint', () => {
  test('warns when a pack knowledge verification command bakes in a foreign runner', () => {
    const issues = mismatchIssues(
      doctorStub({ manager: PackageManager.Npm, knowledgeVerification: ['bun test'] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.message).toContain('bun');
    expect(issues[0]!.message).toContain('npm');
  });

  test('does NOT warn when the hard-coded runner agrees with the detected toolchain', () => {
    expect(
      mismatchIssues(doctorStub({ manager: PackageManager.Bun, knowledgeVerification: ['bun test'] })),
    ).toHaveLength(0);
  });

  test('does NOT warn on a templated <pm-run> command', () => {
    expect(
      mismatchIssues(
        doctorStub({ manager: PackageManager.Npm, knowledgeVerification: ['<pm-run> test'] }),
      ),
    ).toHaveLength(0);
  });

  test('warns on a foreign runner baked into a pack pipeline gate', () => {
    const issues = mismatchIssues(
      doctorStub({ manager: PackageManager.Npm, pipelineGate: 'pnpm test' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('pnpm');
  });

  test('the lint is a warning, never an error (report still passes)', () => {
    const report = buildPackDoctorReport(
      doctorStub({ manager: PackageManager.Npm, knowledgeVerification: ['yarn test'] }),
    );
    expect(report.summary.errors).toBe(0);
    expect(report.passed).toBe(true);
  });
});
