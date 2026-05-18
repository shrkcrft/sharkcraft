import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  BundleReplayStatus,
  createFeatureBundleState,
  markBundlePlanApplied,
  recomputeBundleStatus,
  replayAllBundles,
  upsertBundlePlan,
  writeFeatureBundle,
} from '../index.ts';

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

describe('r12 cross-bundle replay', () => {
  test('replayAll returns counts across multiple bundles', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-cross-'));
    // Bundle A: clean, no plans.
    let a = createFeatureBundleState({ id: 'a', task: 't', projectRoot: root, packet: emptyPacket() });
    writeFeatureBundle(root, a);
    // Bundle B: tampered (plan applied but missing file).
    let b = createFeatureBundleState({ id: 'b', task: 't', projectRoot: root, packet: emptyPacket() });
    b = upsertBundlePlan(b, {
      name: 'p1',
      templateId: 'x',
      variables: {},
      missingVariables: [],
      file: 'p1.json',
      status: 'applied',
      expectedTargets: [],
    });
    b = markBundlePlanApplied(b, 'p1');
    b = recomputeBundleStatus(b);
    writeFeatureBundle(root, b);

    const batch = replayAllBundles(root);
    expect(batch.total).toBe(2);
    expect(batch.tamperedCount + batch.warningsCount + batch.missingCount).toBeGreaterThan(0);
    const tampered = batch.reports.find((r) => r.bundleId === 'b');
    expect(tampered?.status).toBe(BundleReplayStatus.Tampered);
  });

  test('topIssues surfaces serious problems', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-cross-2-'));
    let b = createFeatureBundleState({ id: 'b', task: 't', projectRoot: root, packet: emptyPacket() });
    b = upsertBundlePlan(b, {
      name: 'broken',
      templateId: 'x',
      variables: {},
      missingVariables: [],
      file: 'broken.json',
      status: 'applied',
      expectedTargets: [],
    });
    b = markBundlePlanApplied(b, 'broken');
    writeFeatureBundle(root, b);
    const batch = replayAllBundles(root);
    expect(batch.topIssues.length).toBeGreaterThan(0);
  });

  test('match filter limits which bundles are replayed', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-cross-3-'));
    const a = createFeatureBundleState({ id: 'alpha', task: 't', projectRoot: root, packet: emptyPacket() });
    writeFeatureBundle(root, a);
    const b = createFeatureBundleState({ id: 'beta', task: 't', projectRoot: root, packet: emptyPacket() });
    writeFeatureBundle(root, b);
    const batch = replayAllBundles(root, { match: 'alpha' });
    expect(batch.total).toBe(1);
    expect(batch.reports[0]!.bundleId).toBe('alpha');
  });
});
