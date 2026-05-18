import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { analyzeImpact, buildReportSite, inspectSharkcraft } from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r14 impact graph in report site', () => {
  test('--with-impact-graphs writes mermaid + dot files', async () => {
    const outDir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r14-site-'));
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const impact = await analyzeImpact(inspection, { files: ['src/services/user.service.ts'] });
    const impactJson = nodePath.join(outDir, 'impact.json');
    writeFileSync(impactJson, JSON.stringify(impact));
    const result = await buildReportSite(inspection, outDir, {
      impactFile: impactJson,
      withImpactGraphs: true,
    });
    expect(result.impactGraphFiles).toBeDefined();
    expect(result.impactGraphFiles!.length).toBeGreaterThan(0);
    const hasMermaid = result.impactGraphFiles!.some((f) => f.format === 'mermaid');
    const hasDot = result.impactGraphFiles!.some((f) => f.format === 'dot');
    expect(hasMermaid).toBe(true);
    expect(hasDot).toBe(true);
    const detail = readFileSync(nodePath.join(outDir, 'impact-1.html'), 'utf8');
    expect(detail).toContain('Graph source');
    expect(detail.includes('<script')).toBe(false);
  });

  test('without --with-impact-graphs no graph files are written', async () => {
    const outDir = mkdtempSync(nodePath.join(tmpdir(), 'sharkcraft-r14-site-bare-'));
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const result = await buildReportSite(inspection, outDir, {});
    expect(result.impactGraphFiles).toBeUndefined();
  });
});
