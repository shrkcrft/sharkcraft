import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildAgentOrchestrationPlan,
  buildArchitectureViolationsDiff,
  buildComplianceEvidencePacket,
  buildRepositoryIntelligenceGraph,
  buildTaskRiskReport,
  ChangeIntentKind,
  classifyChangeIntent,
  diffApiReports,
  diffDashboardExports,
  diffPackQuality,
  buildApiReport,
  buildProductCoherenceReport,
  buildDashboardExport,
  inspectSharkcraft,
  parseRepositoryGraphExpression,
  queryRepositoryIntelligence,
  scorePack,
  TaskRiskLevel,
  verifyComplianceEvidencePacket,
  getTaskAwareRoleView,
} from '../index.ts';

describe('r20 per-task risk', () => {
  test('low-risk docs task → low risk', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await buildTaskRiskReport('update README typo', inspection);
    expect(r.riskLevel).toBe(TaskRiskLevel.Low);
    expect(r.intent.kind).toBe(ChangeIntentKind.Docs);
  });
  test('release task escalates risk reason', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await buildTaskRiskReport('tag and publish the alpha release', inspection);
    expect(r.reasons.some((reason) => reason.code === 'intent-release')).toBe(true);
  });
  test('humanApprovalRequired set when intent flags review', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await buildTaskRiskReport('change boundaries between core and inspector', inspection);
    expect(r.humanApprovalRequired).toBe(true);
  });
});

describe('r20 task-aware role views', () => {
  test('architect view with task includes architecture commands', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const v = await getTaskAwareRoleView('architect', 'review plugin architecture', inspection);
    expect(v).toBeDefined();
    expect(v?.taskSpecific?.taskCommands.some((c) => c.includes('architecture'))).toBe(true);
  });
  test('release-manager view with release task lists readiness', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const v = await getTaskAwareRoleView('release-manager', 'cut the next alpha release', inspection);
    expect(v?.taskSpecific?.taskCommands.some((c) => c.includes('release readiness'))).toBe(true);
  });
  test('ai-agent view exposes forbidden actions', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const v = await getTaskAwareRoleView('ai-agent', 'help an agent run a task', inspection);
    expect(v?.taskSpecific?.whatNotToDo.some((f) => f.toLowerCase().includes('mcp'))).toBe(true);
  });
});

describe('r20 tsconfig path-aware graph', () => {
  test('resolveAliases reports counts', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection, {
      includeImports: true,
      resolveAliases: true,
    });
    expect(typeof graph.truncation.aliasResolvedEdges).toBe('number');
    expect(graph.truncation.aliasResolvedEdges).toBeGreaterThanOrEqual(0);
  });
  test('no crash without tsconfig', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection, { includeImports: true });
    expect(graph.truncation.aliasResolvedEdges).toBe(0);
  });
});

describe('r20 query DSL v2', () => {
  test('AND keeps within group', () => {
    const { expression, errors } = parseRepositoryGraphExpression('kind:package text:core');
    expect(errors).toEqual([]);
    expect(expression.groups).toHaveLength(1);
    expect(expression.groups[0]?.kinds).toEqual(['package']);
  });
  test('OR splits groups', () => {
    const { expression } = parseRepositoryGraphExpression('kind:package OR kind:test');
    expect(expression.groups).toHaveLength(2);
  });
  test('not:<filter> recorded', () => {
    const { expression } = parseRepositoryGraphExpression('kind:package not:text:dashboard');
    expect(expression.groups[0]?.notText?.[0]).toBe('dashboard');
  });
  test('query OR unions results', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    const { expression } = parseRepositoryGraphExpression('kind:package OR kind:test');
    const r = queryRepositoryIntelligence(graph, expression);
    expect(r.nodes.some((n) => n.kind === 'package')).toBe(true);
    expect(r.nodes.some((n) => n.kind === 'test')).toBe(true);
  });
});

describe('r20 architecture violations diff', () => {
  test('files filter scopes the report', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const diff = await buildArchitectureViolationsDiff(inspection, { files: ['packages/core/src/index.ts'] });
    expect(diff.schema).toBe('sharkcraft.architecture-violations-diff/v1');
    expect(typeof diff.totalCurrent).toBe('number');
  });
  test('missing baseline gracefully warns', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const diff = await buildArchitectureViolationsDiff(inspection, {
      baselineFile: '/tmp/this-does-not-exist.json',
    });
    expect(diff.warnings.some((w) => w.includes('Baseline'))).toBe(true);
  });
});

describe('r20 compliance evidence v2', () => {
  test('manifest has sha256 + sharkcraftVersion', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'r20-evidence-'));
    try {
      const packet = await buildComplianceEvidencePacket(inspection, 'ai-safe-development', dir);
      expect(packet.manifest.length).toBeGreaterThan(0);
      for (const e of packet.manifest) expect(e.sha256.length).toBe(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('sign without secret produces warning', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'r20-evidence-sign-'));
    try {
      delete process.env['SHARKCRAFT_EVIDENCE_SECRET'];
      const packet = await buildComplianceEvidencePacket(inspection, 'ai-safe-development', dir, { sign: true });
      expect(packet.signed).toBe(false);
      expect(packet.warnings.some((w) => w.includes('SHARKCRAFT_EVIDENCE_SECRET'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('verify detects tampering', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'r20-evidence-verify-'));
    try {
      process.env['SHARKCRAFT_EVIDENCE_SECRET'] = 'test-secret';
      await buildComplianceEvidencePacket(inspection, 'ai-safe-development', dir, { sign: true });
      // Tamper: rewrite docs-evidence.json
      writeFileSync(nodePath.join(dir, 'docs-evidence.json'), '{"docs":["tampered"]}', 'utf8');
      const v = verifyComplianceEvidencePacket(dir);
      expect(v.ok).toBe(false);
      expect(v.errors.some((e) => e.includes('SHA256 mismatch'))).toBe(true);
    } finally {
      delete process.env['SHARKCRAFT_EVIDENCE_SECRET'];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('r20 api report diff', () => {
  test('diff reports surface delta zero on identical reports', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r1 = buildApiReport(inspection);
    const r2 = buildApiReport(inspection);
    const diff = diffApiReports(r1, r2);
    expect(diff.publicSurfaceDelta).toBe(0);
  });
  test('removed symbol shows up as breaking suspect', () => {
    const stub: Parameters<typeof diffApiReports>[0] = {
      schema: 'sharkcraft.api-report/v1' as const,
      generatedAt: '2026-01-01T00:00:00.000Z',
      packages: [
        {
          name: '@x/pkg',
          version: '1.0.0',
          packageRoot: '/x',
          hasReadme: true,
          exportedSymbols: ['A', 'B'],
          deprecatedReexports: [],
          notes: [],
        },
      ],
    };
    const next: Parameters<typeof diffApiReports>[1] = {
      ...stub,
      packages: [{ ...stub.packages[0]!, exportedSymbols: ['A'] }],
    };
    const diff = diffApiReports(stub, next);
    expect(diff.entries[0]?.removed).toEqual(['B']);
    expect(diff.entries[0]?.breakingSuspects).toEqual(['B']);
  });
});

describe('r20 pack quality diff', () => {
  test('delta reflects overall change', () => {
    const oldS = {
      schema: 'sharkcraft.pack-quality-score/v1' as const,
      packageName: '@a/b',
      packageVersion: '1.0.0',
      overall: 70,
      dimensions: [
        { id: 'manifest', label: 'manifest', score: 80, weight: 1, notes: [] },
        { id: 'signature', label: 'signature', score: 60, weight: 1, notes: [] },
      ],
      warnings: [],
    };
    const newS = { ...oldS, overall: 80, dimensions: [oldS.dimensions[0]!, { ...oldS.dimensions[1]!, score: 100 }] };
    const diff = diffPackQuality(oldS, newS);
    expect(diff.delta).toBe(10);
    expect(diff.dimensionDeltas.find((d) => d.id === 'signature')?.delta).toBe(40);
    // Ensure scorePack is still importable (sanity)
    expect(typeof scorePack).toBe('function');
  });
});

describe('r20 dashboard export diff', () => {
  test('returns zero deltas for same dir', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'r20-dash-'));
    try {
      const r = await buildDashboardExport(inspection, { outputDir: dir });
      const diff = diffDashboardExports(r.outputDir, r.outputDir);
      expect(diff.metrics.graphNodes.delta).toBe(0);
      expect(diff.metrics.packs.delta).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('r20 product coherence v2', () => {
  test('strict converts warnings to errors', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const report = buildProductCoherenceReport(inspection, { strict: true });
    expect(report.strict).toBe(true);
    expect(report.findings.every((f) => f.severity !== 'warning')).toBe(true);
  });
});

describe('r20 orchestrate with task risk', () => {
  test('riskAware folds taskRisk into plan', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const plan = await buildAgentOrchestrationPlan('change architecture boundaries', inspection, {
      riskAware: true,
    });
    expect(plan.riskAware).toBe(true);
    expect(plan.taskRisk?.task).toBe('change architecture boundaries');
    expect(typeof plan.taskRisk?.score).toBe('number');
    expect(classifyChangeIntent).toBeDefined();
  });
});
