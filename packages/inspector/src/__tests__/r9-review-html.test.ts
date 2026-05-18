import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildReviewPacketV2,
  inspectSharkcraft,
  renderReviewCommentV2,
  renderReviewCommentV2Html,
} from '../index.ts';

describe('review packet v2 HTML render', () => {
  it('renders a self-contained HTML page', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r9-html-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const packet = await buildReviewPacketV2(inspection, { files: ['src/foo.ts'] });
      const html = renderReviewCommentV2(packet, { format: 'html' });
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('SharkCraft review');
      const direct = renderReviewCommentV2Html(packet, {});
      expect(direct.includes('Risk score:')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
