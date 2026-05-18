import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  checkAllPacksCompatibility,
  inspectSharkcraft,
  scoreAllPacks,
} from '../index.ts';

describe('pack quality + compatibility', () => {
  it('returns empty results on no packs', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-pq-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      expect(scoreAllPacks(inspection)).toEqual([]);
      expect(checkAllPacksCompatibility(inspection)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
