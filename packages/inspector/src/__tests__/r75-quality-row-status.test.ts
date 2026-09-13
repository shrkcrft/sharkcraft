/**
 * Round 11 (integration review) — a partial quality gate never renders as a
 * pass on ANY renderer.
 *
 * `IQualityReport.overall` learned `not-verified`, but the dashboard, the HTML
 * report and the report site each re-derived a gate's ROW from `g.passed`, so
 * a boundaries gate whose rule had a dead scope glob read `pass` / `OK` next
 * to an overall `not-verified`. Every row now comes from ONE derivation,
 * `qualityGateStatus`, over the one classification (`examineQualityGate`).
 *
 * The partial gate is real: a warning boundary rule whose scope glob matches
 * no file, through the real inspector, the real renderers and a real report
 * site written to a temp dir.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDashboardQuality } from '../dashboard/dashboard-data.ts';
import { QualityGateExamination } from '../quality-gate-examination.ts';
import { QualityGateStatus } from '../quality-gate-status.ts';
import { qualityGateStatus } from '../quality-gate-row-status.ts';
import { renderQualityHtml } from '../quality-html.ts';
import { examineQualityGate } from '../quality-report-coverage.ts';
import { buildQualityReport } from '../quality-report.ts';
import { buildReportSite } from '../report-site.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const TIMEOUT_MS = 180_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function workspace(files: Record<string, string>): string {
  const root = tempDir('shrk-r75-row-status-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const PARTIAL = {
  'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
  'sharkcraft/boundaries.ts':
    "export default [{ id: 'old.dead', title: 'Old', severity: 'warning', from: ['packages/old/**'], forbiddenImports: ['@scope/ui'] }];\n",
  'src/a.ts': 'export const A = 1;\n',
};

describe('one row status for every quality renderer', () => {
  test('a partial gate is not-verified on the dashboard, the HTML report and the report site — never pass / OK', async () => {
    const root = workspace(PARTIAL);
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildQualityReport({ inspection, config: {} });
    const boundaries = report.gates.find((g) => g.id === 'boundaries')!;
    expect({ passed: boundaries.passed, partial: boundaries.data?.['partial'] }).toEqual({ passed: true, partial: true });
    expect(qualityGateStatus(boundaries)).toBe(QualityGateStatus.NotVerified);

    const dashboard = await buildDashboardQuality(inspection);
    expect(dashboard.gates.find((g) => g.id === 'boundaries')?.status).toBe('not-verified');

    const htmlRow = renderQualityHtml(report)
      .split('\n')
      .find((line) => line.includes('<code>boundaries</code>'));
    expect(htmlRow).toContain('>not-verified<');
    expect(htmlRow).not.toContain('b-pass');

    const out = tempDir('shrk-r75-row-status-site-');
    await buildReportSite(inspection, out);
    const siteRow = readFileSync(join(out, 'quality.html'), 'utf8')
      .split('<tr>')
      .find((row) => row.includes('<code>boundaries</code>'));
    expect(siteRow).toContain('NOT VERIFIED');
    expect(siteRow).not.toContain('>OK<');
  }, TIMEOUT_MS);

  test('control: a gate that examined its whole scope and passed still renders pass / OK', async () => {
    const root = workspace(PARTIAL);
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildQualityReport({ inspection, config: {} });
    const clean = report.gates.find((g) => g.passed && examineQualityGate(g) === QualityGateExamination.Examined);
    expect(clean).toBeDefined();
    expect(qualityGateStatus(clean!)).toBe(QualityGateStatus.Pass);
    const htmlRow = renderQualityHtml(report)
      .split('\n')
      .find((line) => line.includes(`<code>${clean!.id}</code>`));
    expect(htmlRow).toContain('b-pass');
  }, TIMEOUT_MS);
});
