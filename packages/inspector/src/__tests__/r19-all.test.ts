import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildArchitectureMap,
  buildArchitectureViolations,
  buildAgentOrchestrationPlan,
  buildCommandTaxonomy,
  buildComplianceEvidencePacket,
  buildProductCoherenceReport,
  buildRepositoryIntelligenceGraph,
  computeRiskSignals,
  inspectSharkcraft,
  OrchestrationMode,
  parseRepositoryGraphQuery,
  queryRepositoryIntelligence,
  readPolicyOverrideAudit,
  RepoEdgeKind,
  RiskLevel,
} from '../index.ts';

describe('r19 intelligence graph v3', () => {
  test('include-imports adds import edges', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection, { includeImports: true });
    expect(graph.truncation.importEdges).toBeGreaterThan(0);
    expect(graph.edges.some((e) => e.kind === RepoEdgeKind.Imports)).toBe(true);
  });
  test('depends-on edge between packages', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection, { includeImports: true });
    expect(graph.edges.some((e) => e.kind === RepoEdgeKind.DependsOn)).toBe(true);
  });
  test('without --include-imports, no import edges', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    expect(graph.truncation.importEdges).toBe(0);
  });
});

describe('r19 graph query lite', () => {
  test('parse query "kind:file imports:@shrkcrft/core"', () => {
    const q = parseRepositoryGraphQuery('kind:file imports:@shrkcrft/core');
    expect(q.kinds).toEqual(['file']);
    expect(q.imports).toBe('@shrkcrft/core');
  });
  test('query returns matching nodes', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    const r = queryRepositoryIntelligence(graph, { kinds: ['package'] });
    expect(r.nodes.length).toBeGreaterThan(0);
    expect(r.nodes.every((n) => n.kind === 'package')).toBe(true);
  });
  test('text filter narrows results', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const graph = await buildRepositoryIntelligenceGraph(inspection);
    const r = queryRepositoryIntelligence(graph, { text: 'core' });
    expect(r.nodes.length).toBeGreaterThan(0);
  });
});

describe('r19 architecture map v3', () => {
  test('with --signals folds in boundary violation counts', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const map = await buildArchitectureMap(inspection, { signals: true });
    expect(map.signalsEnabled).toBe(true);
    expect(typeof map.boundaryViolationCounts.error).toBe('number');
  });
  test('violations report enumerates boundary violations', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await buildArchitectureViolations(inspection);
    expect(r.schema).toBe('sharkcraft.architecture-violations/v1');
    expect(typeof r.total).toBe('number');
  });
});

describe('r19 risk signals + risk-aware orchestration', () => {
  test('computeRiskSignals returns a level', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = await computeRiskSignals(inspection);
    expect([RiskLevel.Low, RiskLevel.Medium, RiskLevel.High, RiskLevel.Critical]).toContain(r.level);
  });
  test('risk-aware orchestration adds risk to the plan', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const plan = await buildAgentOrchestrationPlan('publish alpha', inspection, {
      mode: OrchestrationMode.Conservative,
      riskAware: true,
    });
    expect(plan.riskAware).toBe(true);
    expect(plan.risk).toBeDefined();
  });
  test('non-risk-aware orchestration omits the risk block', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const plan = await buildAgentOrchestrationPlan('publish alpha', inspection);
    expect(plan.riskAware).toBe(false);
    expect(plan.risk).toBeUndefined();
  });
});

describe('r19 compliance evidence', () => {
  test('writes a manifest + report into the output dir', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const out = mkdtempSync(nodePath.join(tmpdir(), 'r19-compliance-evidence-'));
    try {
      const p = await buildComplianceEvidencePacket(inspection, 'ai-safe-development', out);
      expect(p.schema).toBe('sharkcraft.compliance-evidence/v1');
      expect(p.manifest.length).toBeGreaterThan(0);
      const manifest = JSON.parse(readFileSync(nodePath.join(out, 'manifest.json'), 'utf8'));
      expect(manifest.schema).toBe('sharkcraft.compliance-evidence/v1');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('r19 policy override audit', () => {
  test('readPolicyOverrideAudit returns [] when no log', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const entries = readPolicyOverrideAudit(inspection);
    expect(Array.isArray(entries)).toBe(true);
  });
});

describe('r19 command taxonomy', () => {
  test('produces non-empty groups for a non-empty catalog', () => {
    const r = buildCommandTaxonomy({
      catalog: [
        { command: 'doctor', description: 'd', safetyLevel: 'read-only' },
        { command: 'brief', description: 'b', safetyLevel: 'writes-drafts' },
        { command: 'release readiness', description: 'r', safetyLevel: 'read-only' },
        { command: 'compliance check', description: 'c', safetyLevel: 'read-only' },
      ],
    });
    expect(r.schema).toBe('sharkcraft.command-taxonomy/v1');
    expect(r.groups.length).toBeGreaterThan(0);
    expect(r.groups.some((g) => g.commands.length > 0)).toBe(true);
  });
});

describe('r19 product coherence', () => {
  test('SharkCraft README passes the coherence check', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    const r = buildProductCoherenceReport(inspection);
    expect(r.passed).toBe(true);
  });
});
