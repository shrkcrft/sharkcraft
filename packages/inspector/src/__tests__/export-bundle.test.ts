import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildTaskPacket,
  createFeatureBundleState,
  exportFeatureBundle,
  inspectSharkcraft,
  writeFeatureBundle,
} from '../index.ts';

describe('export bundle', () => {
  it('exports a feature bundle to a folder', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-exp-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = buildTaskPacket(inspection, 'a');
      writeFeatureBundle(
        root,
        createFeatureBundleState({ id: 'bx', task: 'a', projectRoot: root, packet }),
      );
      const out = nodePath.join(root, 'export');
      const r = exportFeatureBundle(root, 'bx', out);
      expect(r).not.toBeNull();
      expect(r!.files.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
