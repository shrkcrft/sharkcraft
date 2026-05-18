import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildTaskPacket,
  createFeatureBundleState,
  inspectSharkcraft,
  markBundlePlanApplied,
  renderBundleValidationHtml,
  setBundleDependencies,
  upsertBundlePlan,
  writeFeatureBundle,
} from '../index.ts';

function tempRoot(): string {
  const r = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r10-'));
  writeFileSync(nodePath.join(r, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  return r;
}

describe('bundle lifecycle (status/next/report/review surfaces)', () => {
  it('persists planGroups + dependencies and supports markBundlePlanApplied', async () => {
    const root = tempRoot();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = buildTaskPacket(inspection, 'a');
      let bundle = createFeatureBundleState({ id: 'b', task: 'a', projectRoot: root, packet });
      bundle = upsertBundlePlan(bundle, {
        name: 'p1', templateId: 't', variables: {}, missingVariables: [], file: 'p1.json', status: 'reviewed', expectedTargets: [],
      });
      bundle = upsertBundlePlan(bundle, {
        name: 'p2', templateId: 't', variables: {}, missingVariables: [], file: 'p2.json', status: 'reviewed', expectedTargets: [],
      });
      bundle = setBundleDependencies(
        bundle,
        [{ from: 'p1', to: 'p2', reason: 'test' }],
        ['p1', 'p2'],
      );
      writeFeatureBundle(root, bundle);
      const applied = markBundlePlanApplied(bundle, 'p1');
      expect(applied.plans[0]?.status).toBe('applied');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders a self-contained HTML validation report', async () => {
    const root = tempRoot();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = buildTaskPacket(inspection, 'a');
      const bundle = createFeatureBundleState({ id: 'b', task: 'a', projectRoot: root, packet });
      const html = renderBundleValidationHtml(bundle, {
        startedAt: '2026-05-13T00:00:00Z',
        finishedAt: '2026-05-13T00:00:01Z',
        passed: true,
        warnings: 0,
        commandsRun: [{ command: 'boundaries', passed: true, note: '0 violations' }],
        boundaryViolations: 0,
        reportFile: 'reports/v.json',
      });
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('Gate matrix');
      expect(html).toContain('boundaries');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
