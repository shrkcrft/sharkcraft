import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildTaskPacket,
  createFeatureBundleState,
  decomposeTask,
  inspectSharkcraft,
  listFeatureBundles,
  readFeatureBundle,
  writeFeatureBundle,
  FeatureBundleStatus,
  recomputeBundleStatus,
  upsertBundlePlan,
} from '../index.ts';

function tempRoot(): string {
  return mkdtempSync(nodePath.join(tmpdir(), 'shrk-bundle-'));
}

describe('feature bundle', () => {
  it('creates a bundle file under .sharkcraft/bundles', async () => {
    const root = tempRoot();
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '0.0.0' }),
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = buildTaskPacket(inspection, 'add a feature');
      const decomposition = decomposeTask(inspection, 'add a feature');
      const state = createFeatureBundleState({
        id: '2024-01-01-test',
        task: 'add a feature',
        projectRoot: root,
        packet,
        decomposition,
      });
      const written = writeFeatureBundle(root, state);
      expect(written.status).toBe(FeatureBundleStatus.Draft);
      expect(written.task).toBe('add a feature');
      const file = nodePath.join(root, '.sharkcraft', 'bundles', '2024-01-01-test', 'bundle.json');
      expect(existsSync(file)).toBe(true);
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      expect(parsed.id).toBe('2024-01-01-test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists bundles and reads back by id', async () => {
    const root = tempRoot();
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'x', version: '0.0.0' }),
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = buildTaskPacket(inspection, 'a');
      const decomposition = decomposeTask(inspection, 'a');
      writeFeatureBundle(
        root,
        createFeatureBundleState({ id: 'aaa', task: 'a', projectRoot: root, packet, decomposition }),
      );
      writeFeatureBundle(
        root,
        createFeatureBundleState({ id: 'bbb', task: 'b', projectRoot: root, packet, decomposition }),
      );
      const all = listFeatureBundles(root);
      expect(all.map((b) => b.id).sort()).toEqual(['aaa', 'bbb']);
      const read = readFeatureBundle(root, 'aaa');
      expect(read?.task).toBe('a');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recomputes status after upserting an applied plan', () => {
    const base = createFeatureBundleState({
      id: 'x',
      task: 't',
      projectRoot: '/tmp',
      packet: { recommendedPipelines: [], recommendedCliCommands: [], forbiddenActions: [] } as any,
    });
    const withPlan = upsertBundlePlan(base, {
      name: 'p1',
      templateId: 'foo',
      variables: {},
      missingVariables: [],
      file: 'p1.json',
      status: 'applied',
      expectedTargets: ['src/foo.ts'],
    });
    const next = recomputeBundleStatus(withPlan);
    expect(next.status).toBe(FeatureBundleStatus.Applied);
  });
});
