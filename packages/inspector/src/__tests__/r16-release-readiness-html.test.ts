import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildReleaseReadiness,
  findNewestPreflightSummary,
  inspectSharkcraft,
  renderReleaseReadinessHtml,
} from '../index.ts';

describe('r16 release readiness extensions', () => {
  test('html render contains verdict + checklist', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const report = await buildReleaseReadiness(inspection, {});
    const html = renderReleaseReadinessHtml(report);
    expect(html).toContain('Release readiness');
    expect(html).toContain('Checklist');
    expect(html.includes('<script')).toBe(false);
  });
  test('preflight auto-discovery picks newest file', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'r16-preflight-'));
    const dir = nodePath.join(root, '.sharkcraft', 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(nodePath.join(dir, 'release-preflight-old.json'), '{"passed":true}', 'utf8');
    const newFile = nodePath.join(dir, 'release-preflight-new.json');
    writeFileSync(newFile, '{"passed":true}', 'utf8');
    // Touch the new file to make sure mtime is later.
    const now = Date.now();
    utimesSync(newFile, now / 1000 + 60, now / 1000 + 60);
    const found = findNewestPreflightSummary(root);
    expect(found).toBeTruthy();
    expect(found!.endsWith('release-preflight-new.json')).toBe(true);
  });
});
