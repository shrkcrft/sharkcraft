import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  analyzeImpact,
  buildReportSite,
  buildReportSiteManifest,
  inspectSharkcraft,
} from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r12 report site deep links', () => {
  test('site includes area-map.html and constructs.html', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-site-'));
    const r = await buildReportSite(inspection, dir);
    expect(r.pages['area-map']).toBe('area-map.html');
    expect(r.pages['constructs']).toBe('constructs.html');
    const index = readFileSync(nodePath.join(dir, 'index.html'), 'utf8');
    expect(index).toContain('href="area-map.html"');
    expect(index).toContain('href="constructs.html"');
    expect(index).toContain('href="impact.html"');
  });

  test('impact.html populated when --impact provided', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-site-impact-'));
    // Generate a real impact JSON file in the temp dir.
    const impact = await analyzeImpact(inspection, { files: ['src/services/user.service.ts'] });
    const impactFile = nodePath.join(dir, 'impact-input.json');
    writeFileSync(impactFile, JSON.stringify(impact));
    const r = await buildReportSite(inspection, dir, { impactFile });
    expect(r.impactCount).toBe(1);
    expect(existsSync(nodePath.join(dir, 'impact-1.html'))).toBe(true);
    const manifest = buildReportSiteManifest(r, false);
    const impactPage = manifest.pages.find((p) => p.id === 'impact');
    expect(impactPage?.populated).toBe(true);
  });

  test('manifest marks placeholder pages', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r12-site-placeholder-'));
    const r = await buildReportSite(inspection, dir);
    const manifest = buildReportSiteManifest(r, false);
    const review = manifest.pages.find((p) => p.id === 'review');
    expect(review?.populated).toBe(false);
    const impact = manifest.pages.find((p) => p.id === 'impact');
    expect(impact?.populated).toBe(false);
  });
});
