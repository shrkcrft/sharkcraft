import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  buildCodeIntelligenceChecks,
  DoctorSeverity,
} from '../index.ts';

function writeJson(root: string, rel: string, body: unknown): void {
  const abs = nodePath.join(root, rel);
  mkdirSync(nodePath.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(body, null, 2), 'utf8');
}

describe('buildCodeIntelligenceChecks', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-ci-doctor-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('empty project root: only the info-level "no graph indexed yet" hint', () => {
    const checks = buildCodeIntelligenceChecks(root);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.id).toBe('code-intelligence-graph');
    expect(checks[0]!.severity).toBe(DoctorSeverity.Info);
    expect(checks[0]!.message).toMatch(/no code graph indexed yet/i);
    expect(checks[0]!.category).toBe('code-intelligence');
  });

  test('fresh graph manifest passes as OK with counts', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      projectRoot: root,
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      lastIndexDurationMs: 1234,
      filesIndexed: 42,
      nodesByKind: { file: 42, symbol: 130 },
      edgesByKind: { 'imports-file': 50, 'declares-symbol': 130 },
      digest: 'deadbeef',
      workspacePackages: [],
    });

    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const graph = checks.find((c) => c.id === 'code-intelligence-graph');
    expect(graph).toBeDefined();
    expect(graph!.severity).toBe(DoctorSeverity.Ok);
    expect(graph!.message).toContain('42 files');
    expect(graph!.message).toContain('172 nodes');
    expect(graph!.message).toContain('180 edges');
  });

  test('stale graph manifest emits advisory warning + fix hint', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      projectRoot: root,
      lastIndexedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      lastIndexDurationMs: 1234,
      filesIndexed: 42,
      nodesByKind: { file: 42 },
      edgesByKind: { 'imports-file': 50 },
      digest: 'deadbeef',
      workspacePackages: [],
    });

    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const graph = checks.find((c) => c.id === 'code-intelligence-graph')!;
    expect(graph.severity).toBe(DoctorSeverity.Warning);
    expect(graph.advisory).toBe(true);
    expect(graph.message).toMatch(/stale.*10d ago/);
    expect(graph.fix).toContain('shrk graph index');
    expect(graph.whyThisMatters).toBeDefined();
  });

  test('corrupt graph manifest emits structural warning, not advisory', () => {
    mkdirSync(nodePath.join(root, '.sharkcraft', 'graph'), { recursive: true });
    writeFileSync(
      nodePath.join(root, '.sharkcraft', 'graph', 'meta.json'),
      'not valid json',
      'utf8',
    );

    const checks = buildCodeIntelligenceChecks(root);
    const graph = checks.find((c) => c.id === 'code-intelligence-graph')!;
    expect(graph.severity).toBe(DoctorSeverity.Warning);
    expect(graph.advisory).toBeUndefined();
    expect(graph.message).toMatch(/not valid JSON/);
  });

  test('fresh bridge manifest passes alongside graph', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      filesIndexed: 1,
      nodesByKind: { file: 1 },
      edgesByKind: {},
    });
    writeJson(root, '.sharkcraft/bridge/meta.json', {
      schema: 'sharkcraft.rule-graph/v1',
      lastBuiltAt: new Date(now - 60_000).toISOString(),
      digest: 'cafe',
      nodesByKind: { rule: 5 },
      edgesByKind: { 'applies-rule': 12 },
      sourceCounts: { rule: 5 },
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const bridge = checks.find((c) => c.id === 'code-intelligence-rule-graph')!;
    expect(bridge.severity).toBe(DoctorSeverity.Ok);
    expect(bridge.message).toContain('5 bridge nodes');
    expect(bridge.message).toContain('12 edges');
  });

  test('bridge with >50% files uncovered emits advisory rule-coverage warning', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/bridge/meta.json', {
      schema: 'sharkcraft.rule-graph/v1',
      lastBuiltAt: new Date(now - 60_000).toISOString(),
      digest: 'beef',
      nodesByKind: {},
      edgesByKind: {},
      sourceCounts: {},
      filesTotal: 100,
      filesCoveredByRules: 30,
      filesUncoveredByRules: 70,
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const cov = checks.find((c) => c.id === 'code-intelligence-rule-coverage')!;
    expect(cov).toBeDefined();
    expect(cov.severity).toBe(DoctorSeverity.Warning);
    expect(cov.advisory).toBe(true);
    expect(cov.message).toContain('30/100 files covered');
    expect(cov.message).toContain('70 file(s) have no applicable rule');
  });

  test('bridge with high coverage reports OK rule-coverage', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/bridge/meta.json', {
      schema: 'sharkcraft.rule-graph/v1',
      lastBuiltAt: new Date(now - 60_000).toISOString(),
      digest: 'beef',
      nodesByKind: {},
      edgesByKind: {},
      sourceCounts: {},
      filesTotal: 100,
      filesCoveredByRules: 80,
      filesUncoveredByRules: 20,
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const cov = checks.find((c) => c.id === 'code-intelligence-rule-coverage')!;
    expect(cov.severity).toBe(DoctorSeverity.Ok);
    expect(cov.message).toContain('80/100 files covered');
  });

  test('legacy bridge manifest without coverage fields produces no rule-coverage check', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/bridge/meta.json', {
      schema: 'sharkcraft.rule-graph/v1',
      lastBuiltAt: new Date(now - 60_000).toISOString(),
      digest: 'beef',
      nodesByKind: {},
      edgesByKind: {},
      sourceCounts: {},
      // intentionally omit filesTotal/filesCoveredByRules
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    expect(checks.find((c) => c.id === 'code-intelligence-rule-coverage')).toBeUndefined();
  });

  test('quality-gate last run = fail surfaces warning + failing gate ids', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/quality-gates/last.json', {
      schema: 'sharkcraft.quality-gate-report/v1',
      overall: 'fail',
      startedAt: new Date(now - 60_000).toISOString(),
      totalDurationMs: 500,
      counts: { pass: 2, fail: 1, warn: 0, skipped: 0 },
      gates: [
        { id: 'graph-fresh', status: 'pass' },
        { id: 'arch', status: 'fail' },
        { id: 'impact', status: 'pass' },
      ],
      diagnostics: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const gate = checks.find((c) => c.id === 'code-intelligence-quality-gate')!;
    expect(gate.severity).toBe(DoctorSeverity.Warning);
    expect(gate.message).toContain('FAIL');
    expect(gate.message).toContain('arch');
    expect(gate.fix).toContain('shrk gate');
  });

  test('quality-gate last run = pass shows OK with no extra hints', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/quality-gates/last.json', {
      schema: 'sharkcraft.quality-gate-report/v1',
      overall: 'pass',
      startedAt: new Date(now - 60_000).toISOString(),
      totalDurationMs: 500,
      counts: { pass: 3, fail: 0, warn: 0, skipped: 0 },
      gates: [],
      diagnostics: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const gate = checks.find((c) => c.id === 'code-intelligence-quality-gate')!;
    expect(gate.severity).toBe(DoctorSeverity.Ok);
    expect(gate.fix).toBeUndefined();
  });

  test('stale api-surface signature cache emits advisory', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/api-surface/signatures.json', {
      schema: 'sharkcraft.api-surface-cache/v1',
      generatedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      files: { 'packages/foo/src/index.ts': { sha1: 'x', signatures: {} } },
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const api = checks.find((c) => c.id === 'code-intelligence-api-surface')!;
    expect(api.severity).toBe(DoctorSeverity.Warning);
    expect(api.advisory).toBe(true);
    expect(api.message).toMatch(/stale/);
  });

  test('failed migration on disk surfaces a warning with resume command', () => {
    writeJson(root, '.sharkcraft/migrations/move-utils.state.json', {
      schema: 'sharkcraft.migration-run/v1',
      migration: { id: 'move-utils', title: 'Move utils → core' },
      dryRun: false,
      startedAt: '2026-05-22T10:00:00Z',
      totalDurationMs: 100,
      overall: 'fail',
      steps: [
        { index: 0, id: 'rewrite', kind: 'structural-rewrite', status: 'applied', message: 'ok', durationMs: 50, diagnostics: [] },
        { index: 1, id: 'typecheck', kind: 'check', status: 'failed', message: 'tsc failed', durationMs: 50, diagnostics: [] },
      ],
    });
    writeJson(root, '.sharkcraft/migrations/clean.state.json', {
      schema: 'sharkcraft.migration-run/v1',
      migration: { id: 'clean', title: 'Clean run' },
      dryRun: false,
      startedAt: '2026-05-22T10:00:00Z',
      totalDurationMs: 100,
      overall: 'pass',
      steps: [],
    });

    const checks = buildCodeIntelligenceChecks(root);
    const mig = checks.find((c) => c.id === 'code-intelligence-migrations')!;
    expect(mig).toBeDefined();
    expect(mig.severity).toBe(DoctorSeverity.Warning);
    expect(mig.message).toContain('move-utils');
    expect(mig.message).toContain('typecheck');
    expect(mig.fix).toContain('shrk migrate resume move-utils');
  });

  test('architecture: baseline present, last delta = 0 reports OK', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    const snap = {
      schema: 'sharkcraft.architecture-snapshot/v1',
      generatedAt: new Date(now - 60_000).toISOString(),
      filesAnalyzed: 100,
      countsBySeverity: { error: 0, warning: 1, info: 0 },
      countsByKind: {},
      violationIds: ['barrel-fat|src/foo.ts'],
    };
    writeJson(root, '.sharkcraft/architecture/baseline.json', snap);
    writeJson(root, '.sharkcraft/architecture/last.json', snap);

    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const arch = checks.find((c) => c.id === 'code-intelligence-architecture')!;
    expect(arch.severity).toBe(DoctorSeverity.Ok);
    expect(arch.message).toContain('Within baseline');
  });

  test('architecture: new violation in last vs baseline → Warning + delta + sample', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/architecture/baseline.json', {
      schema: 'sharkcraft.architecture-snapshot/v1',
      generatedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      filesAnalyzed: 100,
      countsBySeverity: { error: 0, warning: 1, info: 0 },
      countsByKind: {},
      violationIds: ['barrel-fat|src/foo.ts'],
    });
    writeJson(root, '.sharkcraft/architecture/last.json', {
      schema: 'sharkcraft.architecture-snapshot/v1',
      generatedAt: new Date(now - 60_000).toISOString(),
      filesAnalyzed: 100,
      countsBySeverity: { error: 1, warning: 1, info: 0 },
      countsByKind: {},
      violationIds: ['barrel-fat|src/foo.ts', 'cycle|src/bar.ts'],
    });

    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const arch = checks.find((c) => c.id === 'code-intelligence-architecture')!;
    expect(arch.severity).toBe(DoctorSeverity.Warning);
    expect(arch.message).toContain('1 new');
    expect(arch.message).toContain('cycle|src/bar.ts');
    expect(arch.message).toContain('error +1');
    expect(arch.fix).toContain('shrk arch baseline write');
  });

  test('architecture: last only, no baseline → Info nudge to freeze', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/architecture/last.json', {
      schema: 'sharkcraft.architecture-snapshot/v1',
      generatedAt: new Date(now - 60_000).toISOString(),
      filesAnalyzed: 100,
      countsBySeverity: { error: 2, warning: 3, info: 0 },
      countsByKind: {},
      violationIds: [],
    });

    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const arch = checks.find((c) => c.id === 'code-intelligence-architecture')!;
    expect(arch.severity).toBe(DoctorSeverity.Info);
    expect(arch.message).toContain('No baseline frozen');
    expect(arch.fix).toContain('shrk arch baseline write');
  });

  test('architecture: baseline only, no last → Info nudge to run arch check', () => {
    writeJson(root, '.sharkcraft/architecture/baseline.json', {
      schema: 'sharkcraft.architecture-snapshot/v1',
      generatedAt: '2026-05-22T11:00:00Z',
      filesAnalyzed: 0,
      countsBySeverity: { error: 0, warning: 0, info: 0 },
      countsByKind: {},
      violationIds: [],
    });
    const checks = buildCodeIntelligenceChecks(root);
    const arch = checks.find((c) => c.id === 'code-intelligence-architecture')!;
    expect(arch.severity).toBe(DoctorSeverity.Info);
    expect(arch.fix).toContain('shrk arch check');
  });

  test('graph with cycle count surfaces both inline tag and cycles advisory', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      filesIndexed: 50,
      nodesByKind: { file: 50 },
      edgesByKind: { 'imports-file': 60 },
      cycleCount: 2,
      largestCycleSize: 4,
      filesInCycles: 6,
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const graph = checks.find((c) => c.id === 'code-intelligence-graph')!;
    expect(graph.message).toContain('2 cycles');
    expect(graph.message).toContain('largest 4');
    const cyc = checks.find((c) => c.id === 'code-intelligence-graph-cycles')!;
    expect(cyc).toBeDefined();
    expect(cyc.severity).toBe(DoctorSeverity.Warning);
    expect(cyc.advisory).toBe(true);
    expect(cyc.message).toContain('largest spans 4');
    expect(cyc.message).toContain('6 file(s) in cycles');
  });

  test('graph with single small 2-file cycle stays Ok without cycles advisory', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      filesIndexed: 10,
      nodesByKind: { file: 10 },
      edgesByKind: { 'imports-file': 5 },
      cycleCount: 1,
      largestCycleSize: 2,
      filesInCycles: 2,
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const graph = checks.find((c) => c.id === 'code-intelligence-graph')!;
    expect(graph.message).toContain('1 cycle');
    expect(checks.find((c) => c.id === 'code-intelligence-graph-cycles')).toBeUndefined();
  });

  test('unresolved imports surface as regular warning with sample specifiers', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      filesIndexed: 10,
      nodesByKind: { file: 10 },
      edgesByKind: { 'imports-file': 5 },
      unresolvedImportCount: 4,
      filesWithUnresolvedImports: 3,
      unresolvedImportSamples: ['./missing', './also-missing', '@scope/gone'],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const u = checks.find((c) => c.id === 'code-intelligence-graph-unresolved')!;
    expect(u).toBeDefined();
    expect(u.severity).toBe(DoctorSeverity.Warning);
    expect(u.advisory).toBeUndefined(); // not advisory — real DX issue
    expect(u.message).toContain('4 unresolved import(s)');
    expect(u.message).toContain('3 file(s)');
    expect(u.message).toContain('"./missing"');
  });

  test('zero unresolved imports → no doctor warning even when field present', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      filesIndexed: 10,
      nodesByKind: { file: 10 },
      edgesByKind: { 'imports-file': 5 },
      unresolvedImportCount: 0,
      filesWithUnresolvedImports: 0,
      unresolvedImportSamples: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    expect(checks.find((c) => c.id === 'code-intelligence-graph-unresolved')).toBeUndefined();
  });

  test('graph without cycle fields stays backward-compatible (no inline tag, no warning)', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      filesIndexed: 10,
      nodesByKind: { file: 10 },
      edgesByKind: { 'imports-file': 5 },
      // no cycleCount field
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const graph = checks.find((c) => c.id === 'code-intelligence-graph')!;
    expect(graph.message).not.toContain('cycle');
    expect(checks.find((c) => c.id === 'code-intelligence-graph-cycles')).toBeUndefined();
  });

  test('impact run = high risk surfaces Warning + validation hint', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/impact/last.json', {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: new Date(now - 60_000).toISOString(),
      inputKind: 'files',
      inputSummary: 'packages/core/src/index.ts',
      risk: 'high',
      directDependentCount: 12,
      transitiveDependentCount: 87,
      affectedPackageCount: 5,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 4,
      publicApiTouched: true,
      riskReasons: ['public API touched'],
      validationScope: ['bun test packages/core'],
      diagnostics: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const ic = checks.find((c) => c.id === 'code-intelligence-impact')!;
    expect(ic).toBeDefined();
    expect(ic.severity).toBe(DoctorSeverity.Warning);
    expect(ic.advisory).toBeUndefined();
    expect(ic.message).toContain('high');
    expect(ic.message).toContain('12 direct + 87 transitive');
    expect(ic.message).toContain('Public API touched');
  });

  test('impact run = low risk surfaces Ok one-liner', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/impact/last.json', {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: new Date(now - 60_000).toISOString(),
      inputKind: 'gitref',
      inputSummary: 'gitref:HEAD~1',
      risk: 'low',
      directDependentCount: 2,
      transitiveDependentCount: 5,
      affectedPackageCount: 1,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 1,
      publicApiTouched: false,
      riskReasons: [],
      validationScope: [],
      diagnostics: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const ic = checks.find((c) => c.id === 'code-intelligence-impact')!;
    expect(ic.severity).toBe(DoctorSeverity.Ok);
  });

  test('stale impact run downgrades a high-risk warning to advisory', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/impact/last.json', {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      inputKind: 'files',
      inputSummary: 'old.ts',
      risk: 'high',
      directDependentCount: 1,
      transitiveDependentCount: 1,
      affectedPackageCount: 1,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 0,
      publicApiTouched: false,
      riskReasons: [],
      validationScope: [],
      diagnostics: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const ic = checks.find((c) => c.id === 'code-intelligence-impact')!;
    expect(ic.severity).toBe(DoctorSeverity.Warning);
    expect(ic.advisory).toBe(true);
  });

  test('framework scan with entity counts reports OK with breakdown', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/framework/meta.json', {
      schema: 'sharkcraft.framework/v1',
      lastBuiltAt: new Date(now - 60_000).toISOString(),
      digest: 'd',
      countsByFramework: { nestjs: 12, react: 47, express: 3 },
      countsBySubtype: { 'nestjs:controller': 8, 'react:component': 47 },
      frameworks: ['nestjs', 'react', 'express'],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const fw = checks.find((c) => c.id === 'code-intelligence-framework')!;
    expect(fw.severity).toBe(DoctorSeverity.Ok);
    expect(fw.message).toContain('62 framework entities');
    expect(fw.message).toContain('react=47');
    expect(fw.message).toContain('nestjs=12');
  });

  test('framework scan with zero entities surfaces advisory hint', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/framework/meta.json', {
      schema: 'sharkcraft.framework/v1',
      lastBuiltAt: new Date(now - 60_000).toISOString(),
      digest: 'd',
      countsByFramework: {},
      countsBySubtype: {},
      frameworks: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const fw = checks.find((c) => c.id === 'code-intelligence-framework')!;
    expect(fw.severity).toBe(DoctorSeverity.Info);
    expect(fw.advisory).toBe(true);
  });

  test('framework scan staler than threshold flips to advisory warning', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/framework/meta.json', {
      schema: 'sharkcraft.framework/v1',
      lastBuiltAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      digest: 'd',
      countsByFramework: { react: 10 },
      countsBySubtype: { 'react:component': 10 },
      frameworks: ['react'],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const fw = checks.find((c) => c.id === 'code-intelligence-framework')!;
    expect(fw.severity).toBe(DoctorSeverity.Warning);
    expect(fw.advisory).toBe(true);
  });

  test('structural pattern registry with broken entries surfaces Warning + sample', () => {
    writeJson(root, '.sharkcraft/structural/patterns.json', {
      schema: 'sharkcraft.structural-pattern-registry/v1',
      patterns: [
        {
          id: 'good',
          pattern: { kind: 'Decorator', name: 'Controller' },
          addedAt: '2026-05-20T10:00:00Z',
          lastValidatedAt: '2026-05-22T11:59:00Z',
        },
        {
          id: 'broken',
          pattern: { kind: 'NoSuch' },
          addedAt: '2026-05-20T10:00:00Z',
          lastValidationError: 'pattern.kind "NoSuch" is not a known matcher kind',
        },
      ],
    });
    const checks = buildCodeIntelligenceChecks(root);
    const s = checks.find((c) => c.id === 'code-intelligence-structural-search')!;
    expect(s.severity).toBe(DoctorSeverity.Warning);
    expect(s.message).toContain('1/2 registered pattern');
    expect(s.message).toContain('broken');
  });

  test('structural pattern registry with all-valid entries → OK', () => {
    writeJson(root, '.sharkcraft/structural/patterns.json', {
      schema: 'sharkcraft.structural-pattern-registry/v1',
      patterns: [
        {
          id: 'p',
          pattern: { kind: 'Decorator', name: 'Controller' },
          addedAt: '2026-05-20T10:00:00Z',
          lastValidatedAt: '2026-05-22T11:59:00Z',
        },
      ],
    });
    const checks = buildCodeIntelligenceChecks(root);
    const s = checks.find((c) => c.id === 'code-intelligence-structural-search')!;
    expect(s.severity).toBe(DoctorSeverity.Ok);
  });

  test('empty pattern registry → advisory Info nudge', () => {
    writeJson(root, '.sharkcraft/structural/patterns.json', {
      schema: 'sharkcraft.structural-pattern-registry/v1',
      patterns: [],
    });
    const checks = buildCodeIntelligenceChecks(root);
    const s = checks.find((c) => c.id === 'code-intelligence-structural-search')!;
    expect(s.severity).toBe(DoctorSeverity.Info);
    expect(s.advisory).toBe(true);
  });

  test('pattern registry with unvalidated entries → advisory Info to run validate', () => {
    writeJson(root, '.sharkcraft/structural/patterns.json', {
      schema: 'sharkcraft.structural-pattern-registry/v1',
      patterns: [
        {
          id: 'unchecked',
          pattern: { kind: 'Decorator', name: 'Controller' },
          addedAt: '2026-05-20T10:00:00Z',
        },
      ],
    });
    const checks = buildCodeIntelligenceChecks(root);
    const s = checks.find((c) => c.id === 'code-intelligence-structural-search')!;
    expect(s.severity).toBe(DoctorSeverity.Info);
    expect(s.advisory).toBe(true);
    expect(s.fix).toContain('shrk search-structural registry validate');
  });

  test('impact baseline + last with same counts → Ok', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    const snap = {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: new Date(now - 60_000).toISOString(),
      inputKind: 'files',
      inputSummary: 'core.ts',
      risk: 'medium',
      directDependentCount: 3,
      transitiveDependentCount: 10,
      affectedPackageCount: 2,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 1,
      publicApiTouched: false,
      riskReasons: [],
      validationScope: [],
      diagnostics: [],
    };
    writeJson(root, '.sharkcraft/impact/baseline.json', snap);
    writeJson(root, '.sharkcraft/impact/last.json', snap);
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const b = checks.find((c) => c.id === 'code-intelligence-impact-baseline')!;
    expect(b.severity).toBe(DoctorSeverity.Ok);
    expect(b.message).toContain('Impact within baseline');
  });

  test('impact baseline + last with worsened risk surfaces Warning', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/impact/baseline.json', {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      inputKind: 'files',
      inputSummary: 'core.ts',
      risk: 'low',
      directDependentCount: 3,
      transitiveDependentCount: 5,
      affectedPackageCount: 2,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 1,
      publicApiTouched: false,
      riskReasons: [],
      validationScope: [],
      diagnostics: [],
    });
    writeJson(root, '.sharkcraft/impact/last.json', {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: new Date(now - 60_000).toISOString(),
      inputKind: 'files',
      inputSummary: 'core.ts',
      risk: 'high',
      directDependentCount: 6,
      transitiveDependentCount: 15,
      affectedPackageCount: 4,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 1,
      publicApiTouched: true,
      riskReasons: ['public API'],
      validationScope: [],
      diagnostics: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const b = checks.find((c) => c.id === 'code-intelligence-impact-baseline')!;
    expect(b.severity).toBe(DoctorSeverity.Warning);
    expect(b.message).toContain('worsened');
    expect(b.message).toContain('risk low → high');
  });

  test('impact baseline present but no last surfaces Info nudge', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/impact/baseline.json', {
      schema: 'sharkcraft.impact-run/v1',
      generatedAt: '2026-05-20T10:00:00Z',
      inputKind: 'files',
      inputSummary: 'x',
      risk: 'low',
      directDependentCount: 0,
      transitiveDependentCount: 0,
      affectedPackageCount: 0,
      affectedSymbolCount: 0,
      affectedCallerFileCount: 0,
      affectedRuleCount: 0,
      affectedTemplateCount: 0,
      likelyTestCount: 0,
      publicApiTouched: false,
      riskReasons: [],
      validationScope: [],
      diagnostics: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const b = checks.find((c) => c.id === 'code-intelligence-impact-baseline')!;
    expect(b.severity).toBe(DoctorSeverity.Info);
    expect(b.fix).toContain('shrk impact --via-graph');
  });

  test('intent benchmark with 100% accuracy → Ok', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/context-planner/intent-benchmark.json', {
      schema: 'sharkcraft.intent-benchmark/v1',
      total: 5,
      passed: 5,
      failed: 0,
      accuracy: 1,
      ranAt: new Date(now - 60_000).toISOString(),
      cases: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const c = checks.find((c) => c.id === 'code-intelligence-context-planner')!;
    expect(c.severity).toBe(DoctorSeverity.Ok);
    expect(c.message).toContain('100%');
    expect(c.message).toContain('5/5');
  });

  test('intent benchmark with failures surfaces Warning + sample miss', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/context-planner/intent-benchmark.json', {
      schema: 'sharkcraft.intent-benchmark/v1',
      total: 5,
      passed: 4,
      failed: 1,
      accuracy: 0.8,
      ranAt: new Date(now - 60_000).toISOString(),
      cases: [
        { task: 'fix the bug', expected: 'bug-fix', actual: 'bug-fix', passed: true },
        { task: 'random text', expected: 'feature', actual: 'unknown', passed: false },
      ],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const c = checks.find((c) => c.id === 'code-intelligence-context-planner')!;
    expect(c.severity).toBe(DoctorSeverity.Warning);
    expect(c.advisory).toBe(true); // 80% accuracy stays advisory
    expect(c.message).toContain('80%');
    expect(c.message).toContain('expected=feature actual=unknown');
  });

  test('intent benchmark with very low accuracy surfaces non-advisory Warning', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/context-planner/intent-benchmark.json', {
      schema: 'sharkcraft.intent-benchmark/v1',
      total: 10,
      passed: 5,
      failed: 5,
      accuracy: 0.5,
      ranAt: new Date(now - 60_000).toISOString(),
      cases: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const c = checks.find((c) => c.id === 'code-intelligence-context-planner')!;
    expect(c.severity).toBe(DoctorSeverity.Warning);
    expect(c.advisory).toBeUndefined();
  });

  test('schema mismatch across multiple stores surfaces a single warning', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    // Graph stamped with a future v2 schema
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v2',
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      filesIndexed: 1,
      nodesByKind: {},
      edgesByKind: {},
    });
    // Migrations file with an unknown schema
    writeJson(root, '.sharkcraft/migrations/old.state.json', {
      schema: 'sharkcraft.migration-run/v0',
      migration: { id: 'old' },
      overall: 'fail',
      steps: [],
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    const sc = checks.find((c) => c.id === 'code-intelligence-schema-mismatch')!;
    expect(sc).toBeDefined();
    expect(sc.severity).toBe(DoctorSeverity.Warning);
    expect(sc.message).toContain('2 stored file');
    expect(sc.message).toContain('graph/meta.json');
    expect(sc.message).toContain('migrations/old.state.json');
  });

  test('matching schemas across stores → no mismatch warning', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(now - 60_000).toISOString(),
      filesIndexed: 1,
      nodesByKind: {},
      edgesByKind: {},
    });
    const checks = buildCodeIntelligenceChecks(root, { nowMs: now });
    expect(checks.find((c) => c.id === 'code-intelligence-schema-mismatch')).toBeUndefined();
  });

  test('stale threshold override flips a fresh fixture to advisory', () => {
    const now = Date.parse('2026-05-22T12:00:00Z');
    writeJson(root, '.sharkcraft/graph/meta.json', {
      schema: 'sharkcraft.graph/v1',
      lastIndexedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      filesIndexed: 1,
      nodesByKind: {},
      edgesByKind: {},
    });
    const checks = buildCodeIntelligenceChecks(root, {
      nowMs: now,
      staleThresholdDays: 1,
    });
    const graph = checks.find((c) => c.id === 'code-intelligence-graph')!;
    expect(graph.severity).toBe(DoctorSeverity.Warning);
    expect(graph.advisory).toBe(true);
  });
});
