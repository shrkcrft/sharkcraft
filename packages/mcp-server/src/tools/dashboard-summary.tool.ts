import {
  buildAreaMap,
  buildAiReadinessReport,
  buildCoverageReport,
  buildDriftReport,
  buildQualityReport,
  buildReleaseReadiness,
  buildSafetyAudit,
  evaluatePolicy,
  listConstructs,
  listDevSessionsDetailed,
  listFeatureBundles,
  listPlaybooks,
} from '@shrkcrft/inspector';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IToolDefinition } from '../server/tool-definition.ts';
// DX#4 — derive audit view from ALL_TOOLS at runtime.
import { ALL_TOOLS } from './all-tools.ts';

interface IDashboardSummaryInput {
  includeRecentSessions?: boolean;
  includeRecentBundles?: boolean;
  maxItems?: number;
}

export const getDashboardSummaryTool: IToolDefinition = {
  name: 'get_dashboard_summary',
  description:
    'Compact dashboard summary aggregating quality, safety, readiness, coverage, drift, packs, sessions, bundles, command-safety totals, and recommended next commands. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      includeRecentSessions: { type: 'boolean' },
      includeRecentBundles: { type: 'boolean' },
      maxItems: { type: 'number' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const inspection = ctx.inspection;
    const inp = input as IDashboardSummaryInput;
    const maxItems = typeof inp.maxItems === 'number' ? inp.maxItems : 5;

    const readiness = (() => {
      try {
        return buildAiReadinessReport(inspection);
      } catch {
        return { score: 0, grade: 'unknown' as const };
      }
    })();
    const coverage = (() => {
      try {
        return buildCoverageReport(inspection);
      } catch {
        return { overall: 0, categories: [] as { id: string; score: number }[] };
      }
    })();
    let drift;
    try {
      drift = buildDriftReport(inspection);
    } catch {
      drift = { findings: [], counts: { error: 0, warning: 0, info: 0 } };
    }
    const areas = buildAreaMap(inspection);
    const bundles = listFeatureBundles(ctx.cwd);
    const sessions = listDevSessionsDetailed(ctx.cwd);
    const constructs = listConstructs(inspection);
    const playbooks = listPlaybooks(inspection);

    let quality:
      | { score: number; overall: string; blockers: number; warnings: number }
      | null = null;
    try {
      const q = await buildQualityReport({ inspection, config: {} });
      quality = {
        score: q.score,
        overall: q.overall,
        blockers: q.blockers,
        warnings: q.warnings,
      };
    } catch {
      quality = null;
    }

    let policySummary: {
      registrations: number;
      checks: number;
      passed: boolean;
    } | null = null;
    try {
      const p = await evaluatePolicy(inspection);
      policySummary = {
        registrations: p.registrations.length,
        checks: p.checks.length,
        passed: p.summary.passed,
      };
    } catch {
      policySummary = null;
    }

    const safety = buildSafetyAudit({
      inspection,
      catalog: [],
      mcpTools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description })),
      planSecretEnv: 'SHARKCRAFT_PLAN_SECRET',
      planSecretConfigured:
        typeof process.env['SHARKCRAFT_PLAN_SECRET'] === 'string' &&
        (process.env['SHARKCRAFT_PLAN_SECRET'] as string).length > 0,
    });

    const reportSiteDir = nodePath.join(ctx.cwd, '.sharkcraft', 'reports', 'site');
    const siteAvailable = existsSync(reportSiteDir);

    // Include release-readiness verdict + smoke-report summary when available.
    let releaseReadinessSummary:
      | { ready: boolean; blockers: number; warnings: number }
      | null = null;
    try {
      const rr = await buildReleaseReadiness(inspection, {});
      releaseReadinessSummary = {
        ready: rr.ready,
        blockers: rr.blockers.length,
        warnings: rr.warnings.length,
      };
    } catch {
      releaseReadinessSummary = null;
    }
    const smokeReportFile = nodePath.join(ctx.cwd, '.sharkcraft', 'reports', 'release-smoke.json');
    let smokeSummary:
      | { passed: boolean; scenarios: number; ageMs: number }
      | null = null;
    if (existsSync(smokeReportFile)) {
      try {
        const parsed = JSON.parse(readFileSync(smokeReportFile, 'utf8')) as {
          passed?: boolean;
          scenarios?: { length?: number } | unknown[];
        };
        const mtimeMs = statSync(smokeReportFile).mtimeMs;
        const len = Array.isArray(parsed.scenarios)
          ? parsed.scenarios.length
          : Number((parsed.scenarios as { length?: number } | undefined)?.length ?? 0);
        smokeSummary = {
          passed: parsed.passed === true,
          scenarios: len,
          ageMs: Date.now() - mtimeMs,
        };
      } catch {
        smokeSummary = null;
      }
    }

    const next: string[] = [];
    if (!quality || quality.overall === 'fail') next.push('shrk quality');
    if (drift.counts.error > 0) next.push('shrk drift');
    if (bundles.some((b) => b.status === 'planned' || b.status === 'partially-applied')) {
      const id = bundles.find((b) => b.status !== 'applied' && b.status !== 'validated')?.id;
      if (id) next.push(`shrk bundle status ${id}`);
    }
    if (!siteAvailable) next.push('shrk report site');
    if (constructs.length === 0) next.push('shrk constructs infer');
    if (playbooks.length === 0) next.push('shrk playbooks list');

    const data: Record<string, unknown> = {
      schema: 'sharkcraft.dashboard-summary/v2',
      generatedAt: new Date().toISOString(),
      quality,
      safety: {
        mcpAnyWritable: safety.mcp.anyWritable,
        writesSource: safety.commands.writesSource.length,
        writesDrafts: safety.commands.writesDrafts.length,
        writesSession: safety.commands.writesSession.length,
        runsShell: safety.commands.runsShell.length,
        readOnly: safety.commands.readOnly.length,
      },
      readiness: { score: readiness.score, grade: readiness.grade },
      coverage: { overall: coverage.overall, categories: coverage.categories.length },
      drift: drift.counts,
      areas: areas.areas.length,
      bundles: bundles.length,
      sessions: sessions.length,
      constructs: constructs.length,
      playbooks: playbooks.length,
      packs: {
        total: inspection.packs.validPacks.length,
        invalid: inspection.packs.invalidPacks?.length ?? 0,
      },
      policy: policySummary,
      mcpTools: { total: ALL_TOOLS.length, anyWritable: safety.mcp.anyWritable },
      reportSite: { available: siteAvailable, dir: reportSiteDir },
      releaseReadiness: releaseReadinessSummary,
      releaseSmoke: smokeSummary,
      nextCommands: next.slice(0, maxItems),
    };
    if (inp.includeRecentSessions) {
      data['recentSessions'] = sessions.slice(0, maxItems).map((s) => ({
        id: s.id,
        phase: s.phase,
        task: s.task,
        nextAction: s.nextAction,
      }));
    }
    if (inp.includeRecentBundles) {
      data['recentBundles'] = bundles.slice(0, maxItems).map((b) => ({
        id: b.id,
        task: b.task,
        status: b.status,
        risk: b.riskLevel,
      }));
    }
    return { data };
  },
};
