import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import {
  buildDashboardAdoption,
  buildDashboardArchitecture,
  buildDashboardCapabilities,
  buildDashboardCommands,
  buildDashboardCoverage,
  buildDashboardDoctor,
  buildDashboardDrift,
  buildDashboardGraph,
  buildDashboardHealth,
  buildDashboardMcpSummary,
  buildDashboardOnboarding,
  buildDashboardOverview,
  buildDashboardPacks,
  buildDashboardPipelines,
  buildDashboardPresets,
  buildDashboardReports,
  buildDashboardReview,
  buildDashboardScaffolds,
  buildDashboardSchemas,
  buildDashboardSessionDetail,
  buildDashboardSessions,
} from '../dashboard/dashboard-data.ts';

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-dashboard-data-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.1' }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), '// noop\n');
  return dir;
}

describe('dashboard-data service', () => {
  test('overview/doctor/architecture/coverage/drift are stable JSON', async () => {
    const cwd = makeProject();
    try {
      const inspection = await inspectSharkcraft({ cwd });

      const overview = await buildDashboardOverview(inspection);
      expect(typeof overview.readiness.score).toBe('number');
      expect(overview.summary.scaffoldPatterns).toBeGreaterThanOrEqual(0);

      const doctor = buildDashboardDoctor(inspection);
      expect(doctor.verdict === 'ready' || doctor.verdict === 'not-ready').toBe(true);

      const arch = buildDashboardArchitecture(inspection);
      expect(arch.available).toBe(true);

      const cov = buildDashboardCoverage(inspection);
      expect(cov.available).toBe(true);
      const drift = buildDashboardDrift(inspection);
      expect(drift.available).toBe(true);

      // No function values leak through:
      const json = JSON.parse(JSON.stringify(overview));
      expect(typeof json).toBe('object');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('adoption returns available=false without state, with command hints', async () => {
    const cwd = makeProject();
    try {
      const inspection = await inspectSharkcraft({ cwd });
      const adoption = buildDashboardAdoption(inspection);
      expect(adoption.available).toBe(false);
      expect(adoption.nextCommands.length).toBeGreaterThan(0);
      const cmds = adoption.nextCommands.map((c) => c.command).join('\n');
      expect(cmds).toContain('shrk onboard');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('sessions returns available=true even with zero sessions', async () => {
    const cwd = makeProject();
    try {
      const sessions = buildDashboardSessions(cwd);
      expect(sessions.available).toBe(true);
      expect(sessions.sessions.length).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('session detail without the id returns available=false', async () => {
    const cwd = makeProject();
    try {
      const detail = buildDashboardSessionDetail(cwd, 'no-such-id');
      expect(detail.available).toBe(false);
      expect(detail.sessionId).toBe('no-such-id');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('health/capabilities are read-only', () => {
    const health = buildDashboardHealth(0);
    expect(health.readOnly).toBe(true);
    expect(health.ok).toBe(true);
    const caps = buildDashboardCapabilities();
    expect(caps.readOnly).toBe(true);
    expect(caps.writeEndpoints.length).toBe(0);
    expect(caps.dangerousActions.length).toBe(0);
  });

  test('commands/packs/presets/pipelines/reports/review/scaffolds/schemas/mcp build without crashing', async () => {
    const cwd = makeProject();
    try {
      const inspection = await inspectSharkcraft({ cwd });
      const commands = buildDashboardCommands([
        { command: 'doctor', description: 'd', category: 'general', safetyLevel: 'read-only' },
      ]);
      expect(commands.commands.length).toBe(1);
      const packs = buildDashboardPacks(inspection);
      expect(typeof packs.available).toBe('boolean');
      const presets = buildDashboardPresets(inspection);
      expect(typeof presets.available).toBe('boolean');
      const pipelines = buildDashboardPipelines(inspection);
      expect(typeof pipelines.available).toBe('boolean');
      const reports = buildDashboardReports(inspection);
      expect(reports.available).toBe(true);
      const review = buildDashboardReview(inspection);
      expect(review.available).toBe(false);
      const scaffolds = await buildDashboardScaffolds(inspection);
      expect(typeof scaffolds.available).toBe('boolean');
      const schemas = buildDashboardSchemas();
      expect(schemas.schemas.length).toBeGreaterThan(5);
      const mcp = buildDashboardMcpSummary([{ name: 'doctor', description: 'd' }]);
      expect(mcp.readOnly).toBe(true);
      const graph = buildDashboardGraph(inspection);
      expect(graph.available).toBe(true);
      const onb = buildDashboardOnboarding(inspection);
      expect(onb.available).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
