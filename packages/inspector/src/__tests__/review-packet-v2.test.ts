import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildReviewPacketV2,
  inspectSharkcraft,
  renderReviewCommentV2,
} from '../index.ts';

describe('review packet v2', () => {
  it('builds a v2 packet with required sections', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-rp-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const p = await buildReviewPacketV2(inspection, { files: ['src/x.ts'] });
      expect(p.schema).toBe('sharkcraft.review-packet-v2/v1');
      expect(p.impact.affectedFiles).toEqual(['src/x.ts']);
      expect(p.testImpact).toBeDefined();
      const md = renderReviewCommentV2(p, { format: 'github' });
      expect(md).toContain('SharkCraft review');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
