/**
 * Pack signature release-readiness behavior.
 *
 *   - `buildPackSignatureStatusReport.summary.dev` counts dev-signed packs.
 *   - The per-pack entry surfaces `dev: true` and (after CLI annotation)
 *     `releaseBlocking: true` when the secret is unset.
 *   - `buildSafetyAuditDeep.devSignedPacks` enumerates dev-signed packs.
 *   - `buildReleaseReadiness` emits a blocking check when dev-signed packs
 *     exist and the release secret is unset, or a warning when the secret
 *     IS set (re-sign before tagging).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildPackSignatureStatusReport,
} from '../pack-signature-status.ts';
import { buildSafetyAuditDeep } from '../safety-audit-deep.ts';
import { buildPackSignatureReleaseGate } from '../release-readiness.ts';

interface IFakePackManifest {
  signature?: { signedAt: string; dev?: boolean };
  contributions?: Record<string, readonly string[]>;
}
interface IFakePack {
  packageName: string;
  packageVersion: string;
  packageRoot: string;
  manifest?: IFakePackManifest;
}

function makeInspection(packs: IFakePack[]): Parameters<typeof buildPackSignatureStatusReport>[0] {
  return {
    projectRoot: '/tmp/fake-project',
    packs: { validPacks: packs, discoveredPacks: packs, invalidPacks: [] },
    knowledgeEntries: [],
    templates: [],
    pipelines: [],
    paths: [],
    pathConventions: [],
    rules: [],
    templateRegistry: { list: () => [] },
    pipelineRegistry: { list: () => [] },
    presetRegistry: { list: () => [] },
    pathRegistry: { list: () => [] },
    ruleService: { list: () => [], get: () => undefined, getRelevant: () => [] },
    config: null,
    workspace: {
      projectRoot: '/tmp/fake-project',
      hasPackageJson: true,
      packageJson: { name: 'fake', version: '0.1.0' },
      framework: 'unknown',
      runtime: 'bun',
    },
    boundaries: { rules: [] },
    presets: [],
    hasSharkcraftFolder: true,
    sharkcraftDir: '/tmp/fake-project/sharkcraft',
    sourceFiles: [],
    loaderDiagnostics: [],
    cacheEnabled: false,
    inspectionElapsedMs: 0,
    warnings: [],
  } as unknown as Parameters<typeof buildPackSignatureStatusReport>[0];
}

const ORIG_SECRET = process.env['SHARKCRAFT_PACK_SECRET'];

beforeEach(() => {
  delete process.env['SHARKCRAFT_PACK_SECRET'];
});

afterEach(() => {
  if (ORIG_SECRET === undefined) delete process.env['SHARKCRAFT_PACK_SECRET'];
  else process.env['SHARKCRAFT_PACK_SECRET'] = ORIG_SECRET;
});

describe('pack signature release-readiness', () => {
  test('summary.dev counts dev-signed packs', () => {
    const inspection = makeInspection([
      {
        packageName: 'demo-pack',
        packageVersion: '0.1.0',
        packageRoot: '/tmp/fake-project/node_modules/demo-pack',
        manifest: {
          signature: { signedAt: new Date().toISOString(), dev: true },
          contributions: {},
        },
      },
      {
        packageName: 'release-pack',
        packageVersion: '0.1.0',
        packageRoot: '/tmp/fake-project/node_modules/release-pack',
        manifest: {
          signature: { signedAt: new Date().toISOString() },
          contributions: {},
        },
      },
    ]);
    const report = buildPackSignatureStatusReport(inspection);
    expect(report.summary.dev).toBe(1);
    const devEntry = report.packs.find((p) => p.packageName === 'demo-pack');
    expect(devEntry?.dev).toBe(true);
    const releaseEntry = report.packs.find((p) => p.packageName === 'release-pack');
    expect(releaseEntry?.dev).toBeUndefined();
  });

  test('buildSafetyAuditDeep.devSignedPacks enumerates dev-signed packs', async () => {
    const inspection = makeInspection([
      {
        packageName: 'dev-pack',
        packageVersion: '0.1.0',
        packageRoot: '/tmp/fake-project/node_modules/dev-pack',
        manifest: {
          signature: { signedAt: new Date().toISOString(), dev: true },
          contributions: {},
        },
      },
    ]);
    const deep = await buildSafetyAuditDeep(inspection as Parameters<typeof buildSafetyAuditDeep>[0]);
    expect(deep.devSignedPacks.length).toBe(1);
    expect(deep.devSignedPacks[0]!.packageName).toBe('dev-pack');
    const devCheck = deep.checks.find((c) => c.id.startsWith('dev-signed-pack:'));
    expect(devCheck).toBeTruthy();
    expect(devCheck?.severity).toBe('info');
    expect(devCheck?.message).toContain('NOT release-trusted');
  });

  test('release gate fails closed when dev-signed pack + no secret', () => {
    const inspection = makeInspection([
      {
        packageName: 'dev-pack',
        packageVersion: '0.1.0',
        packageRoot: '/tmp/fake-project/node_modules/dev-pack',
        manifest: {
          signature: { signedAt: new Date().toISOString(), dev: true },
          contributions: {},
        },
      },
    ]);
    delete process.env['SHARKCRAFT_PACK_SECRET'];
    const gate = buildPackSignatureReleaseGate(
      inspection as Parameters<typeof buildPackSignatureReleaseGate>[0],
    );
    expect(gate.id).toBe('pack-signature-release');
    expect(gate.status).toBe('fail');
    expect(gate.message).toMatch(/dev-signed.*SHARKCRAFT_PACK_SECRET is not set/);
    expect(gate.suggestion).toMatch(/Set SHARKCRAFT_PACK_SECRET/);
  });

  test('release gate warns (not blocks) when dev-signed pack + secret available', () => {
    process.env['SHARKCRAFT_PACK_SECRET'] = 'test-secret-for-r52';
    const inspection = makeInspection([
      {
        packageName: 'dev-pack',
        packageVersion: '0.1.0',
        packageRoot: '/tmp/fake-project/node_modules/dev-pack',
        manifest: {
          signature: { signedAt: new Date().toISOString(), dev: true },
          contributions: {},
        },
      },
    ]);
    const gate = buildPackSignatureReleaseGate(
      inspection as Parameters<typeof buildPackSignatureReleaseGate>[0],
    );
    expect(gate.status).toBe('warn');
    expect(gate.message).toMatch(/Release secret is available/);
  });

  test('release gate passes when no dev-signed packs', () => {
    const inspection = makeInspection([
      {
        packageName: 'release-pack',
        packageVersion: '0.1.0',
        packageRoot: '/tmp/fake-project/node_modules/release-pack',
        manifest: {
          signature: { signedAt: new Date().toISOString() },
          contributions: {},
        },
      },
    ]);
    const gate = buildPackSignatureReleaseGate(
      inspection as Parameters<typeof buildPackSignatureReleaseGate>[0],
    );
    expect(gate.status).toBe('pass');
  });
});
