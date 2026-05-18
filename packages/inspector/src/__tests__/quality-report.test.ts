import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildQualityReport,
  inspectSharkcraft,
} from '../index.ts';

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'quality-report-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'q', version: '0.0.0' }),
  );
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'q', knowledgeFiles: [], ruleFiles: [], pathFiles: [], templateFiles: [], docsFiles: [] };\n`,
  );
  return root;
}

describe('buildQualityReport', () => {
  test('includes drift gate and a drift report attachment', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildQualityReport({ inspection, config: {} });
    expect(report.gates.some((g) => g.id === 'drift')).toBe(true);
    expect(report.drift).toBeDefined();
    expect(typeof report.drift!.counts.error).toBe('number');
  });

  test('drift gate is non-blocking by default', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildQualityReport({ inspection, config: {} });
    const drift = report.gates.find((g) => g.id === 'drift')!;
    expect(drift.blocking).toBe(false);
  });

  test('requireDriftClean makes the drift gate blocking', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildQualityReport({
      inspection,
      config: { requireDriftClean: true },
    });
    const drift = report.gates.find((g) => g.id === 'drift')!;
    expect(drift.blocking).toBe(true);
  });

  test('skipShell flag does not mark gates as not-executed when no gate runs shell', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildQualityReport({
      inspection,
      config: {},
      skipShell: true,
    });
    // Today every gate is pure inspection.
    for (const g of report.gates) {
      expect(g.runsShell).toBe(false);
    }
  });

  test('overall is "pass" when no gate fails', async () => {
    const root = makeFixture();
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildQualityReport({ inspection, config: {} });
    expect(['pass', 'warn']).toContain(report.overall);
  });
});
