import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  BundleReplayStatus,
  createFeatureBundleState,
  recordBundleReport,
  recordBundleValidation,
  recomputeBundleStatus,
  markBundlePlanApplied,
  replayBundle,
  writeFeatureBundle,
  upsertBundlePlan,
} from '../index.ts';

function makeBundleDir(): { root: string; bundleId: string } {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r11-replay-'));
  const bundleId = 'fixture-bundle';
  const dir = nodePath.join(root, '.sharkcraft', 'bundles', bundleId);
  mkdirSync(nodePath.join(dir, 'plans'), { recursive: true });
  mkdirSync(nodePath.join(dir, 'reports'), { recursive: true });
  return { root, bundleId };
}

function emptyPacket() {
  return {
    schema: 'sharkcraft.task-packet/v1' as const,
    task: 't',
    summary: 't',
    context: { tokens: 0, sections: [], body: '' },
    relevantTemplates: [],
    relevantRules: [],
    relevantPaths: [],
    actionHints: { commands: [], mcpTools: [], forbiddenActions: [], verificationCommands: [] },
    recommendedPipelines: [],
    forbiddenActions: [],
    verificationCommands: [],
    recommendedCliCommands: [],
    recommendedMcpTools: [],
    humanReviewPoints: [],
  } as unknown as Parameters<typeof createFeatureBundleState>[0]['packet'];
}

describe('r11 bundle replay', () => {
  test('clean replay when audit matches plans', () => {
    const { root, bundleId } = makeBundleDir();
    let bundle = createFeatureBundleState({
      id: bundleId,
      task: 't',
      projectRoot: root,
      packet: emptyPacket(),
    });
    bundle = upsertBundlePlan(bundle, {
      name: 'p1',
      templateId: 'x',
      variables: {},
      missingVariables: [],
      file: 'p1.json',
      status: 'applied',
      expectedTargets: ['src/x.ts'],
    });
    bundle = recomputeBundleStatus(bundle);
    bundle = writeFeatureBundle(root, bundle);
    writeFileSync(
      nodePath.join(root, '.sharkcraft', 'bundles', bundleId, 'plans', 'p1.json'),
      JSON.stringify({ changes: [{ relativePath: 'src/x.ts' }] }),
      'utf8',
    );
    appendFileSync(
      nodePath.join(root, '.sharkcraft', 'bundles', bundleId, 'reports', 'apply-audit.log'),
      `2026-05-13T00:00:00.000Z  applied  p1\n`,
      'utf8',
    );
    // Also record a validation so the no-validation-after-apply warning is suppressed.
    bundle = recordBundleValidation(bundle, {
      startedAt: '2026-05-13T00:01:00Z',
      finishedAt: '2026-05-13T00:02:00Z',
      passed: true,
      warnings: 0,
      commandsRun: [],
      boundaryViolations: 0,
      reportFile: 'reports/validate-2026-05-13.json',
    });
    bundle = recordBundleReport(bundle, 'reports/apply-audit.log');
    bundle = writeFeatureBundle(root, bundle);
    const result = replayBundle(root, bundleId);
    expect(result.status).toBe(BundleReplayStatus.Clean);
  });

  test('missing plan file is flagged', () => {
    const { root, bundleId } = makeBundleDir();
    let bundle = createFeatureBundleState({
      id: bundleId,
      task: 't',
      projectRoot: root,
      packet: emptyPacket(),
    });
    bundle = upsertBundlePlan(bundle, {
      name: 'p1',
      templateId: 'x',
      variables: {},
      missingVariables: [],
      file: 'p1.json',
      status: 'applied',
      expectedTargets: [],
    });
    bundle = markBundlePlanApplied(bundle, 'p1');
    bundle = writeFeatureBundle(root, bundle);
    // do NOT write plan file → missing
    const result = replayBundle(root, bundleId);
    expect(result.status).toBe(BundleReplayStatus.Tampered);
    expect(result.planEntries[0]!.issues).toContain('plan file missing on disk');
  });

  test('missing bundle returns Missing status', () => {
    const { root } = makeBundleDir();
    const result = replayBundle(root, 'does-not-exist');
    expect(result.status).toBe(BundleReplayStatus.Missing);
  });
});
