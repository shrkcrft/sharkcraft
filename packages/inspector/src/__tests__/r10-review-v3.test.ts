import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildReviewPacketV3,
  inspectSharkcraft,
  renderReviewCommentV3,
} from '../index.ts';

describe('review packet v3', () => {
  it('builds a v3 packet with policy + (optional) bundle and renders HTML', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r10-v3-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = await buildReviewPacketV3(inspection, { files: ['src/foo.ts'] });
      expect(packet.schema).toBe('sharkcraft.review-packet-v3/v1');
      expect(packet.v2.schema).toBe('sharkcraft.review-packet-v2/v1');
      expect(packet.policy.summary.passed).toBe(true);
      const html = renderReviewCommentV3(packet, { format: 'html' });
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('SharkCraft review (v3)');
      const md = renderReviewCommentV3(packet, { format: 'markdown' });
      expect(md).toContain('# SharkCraft review (v3)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
