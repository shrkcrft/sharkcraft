/**
 * Ranker explainability, command discovery, fix preview, scaffold
 * coverage, changes summary, PR summary, CI integrity, uncertainty, symbol
 * impact, watch helpers.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  explainCommand,
  suggestCommands,
  suggestDidYouMean,
  type ICommandEntryLike,
} from '../command-suggester.ts';
import {
  buildFixPreview,
  FixKind,
  listFixKinds,
} from '../fix-preview.ts';
import {
  buildScaffoldCoverageReport,
  CoverageGrade,
} from '../scaffold-coverage.ts';
import {
  buildChangesSummary,
  CHANGES_SUMMARY_SCHEMA,
} from '../changes-summary.ts';
import { buildPrSummary, PR_SUMMARY_SCHEMA } from '../pr-summary.ts';
import {
  buildCiIntegrityReport,
  GateStatus,
} from '../ci-integrity-report.ts';
import {
  buildUncertaintySummary,
  UncertaintyLevel,
} from '../uncertainty.ts';
import { findSymbolInProject, SymbolResolution } from '../symbol-index.ts';
import {
  buildWatchPlan,
  maybeRunInWatchMode,
} from '@shrkcrft/cli';
import {
  explainRankerDecision,
  RANKER_EXPLAINABILITY_SCHEMA,
} from '../ranker-explainability.ts';

const TMP_ROOT = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r31-'));

function makeCatalog(): ICommandEntryLike[] {
  return [
    {
      command: 'knowledge stale-check',
      description: 'Validate references and anchors on knowledge entries.',
      category: 'analysis',
      safetyLevel: 'read-only',
      writesFiles: false,
      writesSource: false,
      runsShell: false,
      requiresReview: false,
      mcpAvailable: true,
      aliases: [],
    },
    {
      command: 'knowledge search',
      description: 'Search knowledge entries.',
      category: 'analysis',
      safetyLevel: 'read-only',
      writesFiles: false,
      writesSource: false,
      runsShell: false,
      requiresReview: false,
      mcpAvailable: true,
      aliases: [],
    },
    {
      command: 'feedback rules list',
      description: 'List feedback rules.',
      category: 'analysis',
      safetyLevel: 'read-only',
      writesFiles: false,
      writesSource: false,
      runsShell: false,
      requiresReview: false,
      mcpAvailable: true,
      aliases: [],
    },
    {
      command: 'gen',
      description: 'Generate from a template.',
      category: 'core',
      safetyLevel: 'writes-source',
      writesFiles: true,
      writesSource: true,
      runsShell: false,
      requiresReview: true,
      mcpAvailable: false,
      aliases: [],
    },
  ];
}

// ─────────────────────────── Command discovery ───────────────────────────

describe('command suggester', () => {
  test('typo "knowlege" suggests knowledge', () => {
    const catalog = makeCatalog();
    const { suggestions } = suggestCommands(catalog, 'knowlege', { limit: 5 });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.command).toContain('knowledge');
  });

  test('partial "feed rules" suggests "feedback rules list"', () => {
    const catalog = makeCatalog();
    const { suggestions } = suggestCommands(catalog, 'feed rules');
    expect(suggestions.some((s) => s.command === 'feedback rules list')).toBe(true);
  });

  test('safe-only filters source-writing commands', () => {
    const catalog = makeCatalog();
    const { suggestions } = suggestCommands(catalog, 'gen', { safeOnly: true });
    for (const s of suggestions) expect(s.writesSource).toBe(false);
  });

  test('explainCommand returns exact entry for full match', () => {
    const catalog = makeCatalog();
    const report = explainCommand(catalog, 'feedback rules list');
    expect(report.exact?.command).toBe('feedback rules list');
  });

  test('explainCommand returns candidates when no exact match', () => {
    const catalog = makeCatalog();
    const report = explainCommand(catalog, 'feedback list');
    expect(report.exact).toBeUndefined();
    expect(report.candidates.length).toBeGreaterThan(0);
  });

  test('suggestDidYouMean returns at most N candidates', () => {
    const catalog = makeCatalog();
    const out = suggestDidYouMean(catalog, ['knowlege'], 2);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────── Fix preview ─────────────────────────────────

describe('fix preview', () => {
  test('listFixKinds returns the three kinds', () => {
    const kinds = listFixKinds().map((k) => k.kind);
    expect(kinds).toContain(FixKind.ActionHints);
    expect(kinds).toContain(FixKind.KnowledgeStale);
    expect(kinds).toContain(FixKind.TemplateDrift);
  });

  test('action-hint suggestion marks stubbed needs-human-fill', () => {
    const inspection = {
      projectRoot: TMP_ROOT,
      sharkcraftDir: null,
      packs: { validPacks: [] },
      knowledgeEntries: [
        {
          id: 'r31.test.entry',
          title: 'test entry',
          type: 'rule',
          priority: 'high',
          scope: [],
          tags: ['generator'],
          appliesWhen: ['generate-code'],
          content: 'demo',
        },
      ],
      templates: [],
      pathService: { list: () => [] },
      ruleService: { list: () => [] },
      pipelines: [],
      presetRegistry: { list: () => [] },
      pipelineRegistry: { get: () => undefined },
      workspace: { profiles: [] },
    } as never;
    const report = buildFixPreview(inspection);
    expect(report.kinds).toContain(FixKind.ActionHints);
    if (report.suggestions.length > 0) {
      for (const s of report.suggestions) {
        if (s.kind === FixKind.ActionHints) {
          expect(s.stubbed).toBe(true);
          expect(s.draftBody ?? '').toContain('needs-human-fill');
        }
      }
    }
  });
});

// ─────────────────────────── Scaffold coverage ───────────────────────────

describe('scaffold coverage', () => {
  test('coverage grade is deterministic for an empty inspection', async () => {
    const inspection = makeMinimalInspection();
    const r1 = await buildScaffoldCoverageReport(inspection, { task: 'add a new service' });
    const r2 = await buildScaffoldCoverageReport(inspection, { task: 'add a new service' });
    expect(r1.grade).toBe(r2.grade);
    expect(r1.confidence).toBe(r2.confidence);
  });

  test('missing template surfaces as missing axis', async () => {
    const inspection = makeMinimalInspection();
    const r = await buildScaffoldCoverageReport(inspection, { task: 'add a new service' });
    expect(r.missing).toContain('templates');
    expect([CoverageGrade.Missing, CoverageGrade.Weak, CoverageGrade.Partial]).toContain(r.grade);
  });
});

// ─────────────────────────── Changes summary ─────────────────────────────

describe('changes summary', () => {
  test('files input groups by area', async () => {
    const inspection = { projectRoot: TMP_ROOT } as never;
    const r = await buildChangesSummary(inspection, {
      files: ['packages/cli/src/commands/why.command.ts', 'docs/overview.md'],
    });
    expect(r.schema).toBe(CHANGES_SUMMARY_SCHEMA);
    expect(r.totalFiles).toBe(2);
    expect(r.filesByArea.cli).toContain('packages/cli/src/commands/why.command.ts');
    expect(r.filesByArea.docs).toContain('docs/overview.md');
  });

  test('safety-relevant changes raise risk', async () => {
    const inspection = { projectRoot: TMP_ROOT } as never;
    const r = await buildChangesSummary(inspection, {
      files: ['packages/mcp-server/src/tools/foo.tool.ts'],
    });
    expect(r.touchedMcpTools.length).toBeGreaterThan(0);
    expect(r.suggestedValidationCommands).toContain('shrk safety audit --deep');
  });

  test('JSON shape is stable', async () => {
    const inspection = { projectRoot: TMP_ROOT } as never;
    const r = await buildChangesSummary(inspection, { files: ['a.ts'] });
    expect(typeof r.likelyPrSummary).toBe('string');
    expect(Array.isArray(r.suggestedValidationCommands)).toBe(true);
  });
});

// ─────────────────────────── PR summary ──────────────────────────────────

describe('PR summary', () => {
  test('generates markdown with key sections', async () => {
    const inspection = { projectRoot: TMP_ROOT } as never;
    const r = await buildPrSummary(inspection, { files: ['a.ts'] });
    expect(r.schema).toBe(PR_SUMMARY_SCHEMA);
    const titles = r.sections.map((s) => s.title);
    expect(titles).toContain('Summary');
    expect(titles).toContain('Safety');
    expect(titles).toContain('Validation');
  });

  test('safety section when MCP files change', async () => {
    const inspection = { projectRoot: TMP_ROOT } as never;
    const r = await buildPrSummary(inspection, {
      files: ['packages/mcp-server/src/tools/foo.tool.ts'],
    });
    const safety = r.sections.find((s) => s.title === 'Safety');
    expect(safety).toBeDefined();
    expect(safety!.body).toContain('MCP tool');
  });
});

// ─────────────────────────── CI integrity ────────────────────────────────

describe('CI integrity', () => {
  test('empty reports dir returns unknown verdict', () => {
    const r = buildCiIntegrityReport(TMP_ROOT, { reportsDir: nodePath.join(TMP_ROOT, 'nope') });
    expect(r.overall).toBe(GateStatus.Unknown);
  });

  test('aggregates a stale-check report into pass', () => {
    const dir = nodePath.join(TMP_ROOT, 'r31-ci-pass');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      nodePath.join(dir, 'knowledge-stale.json'),
      JSON.stringify({ summary: { stale: 0, missing: 0, requiredStale: 0, requiredMissing: 0 } }),
      'utf8',
    );
    const r = buildCiIntegrityReport(TMP_ROOT, { reportsDir: dir });
    const stale = r.gates.find((g) => g.id === 'knowledge-stale');
    expect(stale?.status).toBe(GateStatus.Pass);
  });

  test('aggregates a template-drift fail into fail verdict', () => {
    const dir = nodePath.join(TMP_ROOT, 'r31-ci-fail');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      nodePath.join(dir, 'template-drift.json'),
      JSON.stringify({ fail: 1, warn: 0, pass: 5 }),
      'utf8',
    );
    const r = buildCiIntegrityReport(TMP_ROOT, { reportsDir: dir });
    expect(r.overall).toBe(GateStatus.Fail);
  });
});

// ─────────────────────────── Uncertainty ─────────────────────────────────

describe('uncertainty', () => {
  test('no template matched produces medium/low confidence', () => {
    const packet = {
      task: 'add a new service',
      projectOverview: '',
      detectedProfiles: [],
      presetRecommendations: [],
      recommendedPipelines: [],
      context: { body: '', totalTokens: 0, maxTokens: 0 } as never,
      relevantRules: [],
      relevantPaths: [],
      relevantTemplates: [],
      actionHints: { mcpTools: [], commands: [], forbiddenActions: [], verificationCommands: [] } as never,
      recommendedMcpTools: [],
      recommendedCliCommands: [],
      forbiddenActions: [],
      verificationCommands: [],
      humanReviewPoints: [],
      tokenEstimate: 0,
    } as never;
    const u = buildUncertaintySummary(packet);
    expect([UncertaintyLevel.Medium, UncertaintyLevel.Low]).toContain(u.confidence);
    expect(u.uncertainty.some((s) => s.code === 'no-template-matched')).toBe(true);
    expect(u.suggestedCommands.length).toBeGreaterThan(0);
  });

  test('healthy packet returns high confidence', () => {
    const packet = {
      task: 'add a new service',
      projectOverview: '',
      detectedProfiles: [],
      presetRecommendations: [],
      recommendedPipelines: [{ pipelineId: 'p', reason: 'r' }],
      context: { body: '', totalTokens: 0, maxTokens: 0 } as never,
      relevantRules: [],
      relevantPaths: [{ id: 'p', title: 't' } as never],
      relevantTemplates: [{ id: 't', name: 'n' } as never],
      actionHints: { mcpTools: [], commands: [], forbiddenActions: [], verificationCommands: [] } as never,
      recommendedMcpTools: [],
      recommendedCliCommands: [],
      forbiddenActions: [],
      verificationCommands: ['bun test'],
      humanReviewPoints: [],
      tokenEstimate: 0,
    } as never;
    const u = buildUncertaintySummary(packet);
    expect(u.confidence).toBe(UncertaintyLevel.High);
  });
});

// ─────────────────────────── Symbol impact ───────────────────────────────

describe('direct symbol impact', () => {
  test('exact-export symbol resolves', () => {
    const dir = nodePath.join(TMP_ROOT, 'r31-sym');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      nodePath.join(dir, 'a.ts'),
      'export function myExportedThing() {}\n',
      'utf8',
    );
    const r = findSymbolInProject(dir, 'myExportedThing');
    expect(r.exactMatches.length).toBe(1);
    expect(r.primaryFile).toBeDefined();
    expect(r.exactMatches[0]!.resolution).toBe(SymbolResolution.ExactExport);
  });

  test('missing symbol returns empty exactMatches', () => {
    const dir = nodePath.join(TMP_ROOT, 'r31-sym-missing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(nodePath.join(dir, 'a.ts'), 'export const X = 1;\n', 'utf8');
    const r = findSymbolInProject(dir, 'NotPresent');
    expect(r.exactMatches.length).toBe(0);
  });

  test('ambiguous symbol with multiple exports returns alternatives', () => {
    const dir = nodePath.join(TMP_ROOT, 'r31-sym-ambig');
    mkdirSync(dir, { recursive: true });
    writeFileSync(nodePath.join(dir, 'a.ts'), 'export function Shared() {}\n', 'utf8');
    writeFileSync(nodePath.join(dir, 'b.ts'), 'export function Shared() {}\n', 'utf8');
    const r = findSymbolInProject(dir, 'Shared');
    expect(r.exactMatches.length).toBe(2);
    expect(r.primaryFile).toBeUndefined();
  });
});

// ─────────────────────────── Ranker explainability ───────────────────────

describe('ranker explainability', () => {
  test('missing id reports nearestIds and unknown found state', () => {
    const inspection = makeMinimalInspection();
    const r = explainRankerDecision(inspection, { id: 'nope.nonexistent', task: 'random task' });
    expect(r.schema).toBe(RANKER_EXPLAINABILITY_SCHEMA);
    expect(r.found).toBe(false);
    expect(r.included).toBe(false);
  });

  test('existing id with task records matched signals when title overlaps', () => {
    const inspection = makeMinimalInspection({
      knowledgeEntries: [
        {
          id: 'engine.demo-knowledge',
          title: 'service utility knowledge',
          type: 'knowledge',
          priority: 'high',
          scope: [],
          tags: ['service', 'utility'],
          appliesWhen: ['generate-service'],
          content: 'demo',
        },
      ],
    });
    const r = explainRankerDecision(inspection, {
      id: 'engine.demo-knowledge',
      task: 'create a service utility',
    });
    expect(r.found).toBe(true);
    expect(r.matchedSignals.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────── Watch helpers ────────────────────────────

describe('watch helpers', () => {
  test('buildWatchPlan reflects requested debounce + paths', () => {
    const plan = buildWatchPlan(
      { cwd: TMP_ROOT, debounce: 500, paths: ['sharkcraft'] },
      ['doctor', 'stale-check'],
    );
    expect(plan.debounce).toBe(500);
    expect(plan.steps).toContain('doctor');
  });

  test('maybeRunInWatchMode returns null when --watch is absent', async () => {
    const args = { positional: [], flags: new Map(), multiFlags: new Map() } as never;
    const result = await maybeRunInWatchMode(args, async () => 0);
    expect(result).toBeNull();
  });

  test('maybeRunInWatchMode (--watch --once) honors defaultPaths and runs a single snapshot', async () => {
    const args = {
      positional: [],
      flags: new Map<string, string | boolean>([
        ['watch', true],
        ['once', true],
      ]),
      multiFlags: new Map(),
    } as never;
    let snapshots = 0;
    const result = await maybeRunInWatchMode(
      args,
      async () => {
        snapshots += 1;
        return 0;
      },
      { defaultPaths: ['sharkcraft', 'packages'] },
    );
    expect(result).toBe(0);
    expect(snapshots).toBe(1);
  });
});

// ─────────────────────────── helpers ───────────────────────────

interface IMinInspectionOverrides {
  knowledgeEntries?: readonly unknown[];
}

function makeMinimalInspection(overrides: IMinInspectionOverrides = {}): never {
  return {
    projectRoot: TMP_ROOT,
    sharkcraftDir: null,
    workspace: { profiles: [] },
    knowledgeEntries: overrides.knowledgeEntries ?? [],
    templates: [],
    pipelines: [],
    ruleService: { list: () => [] },
    pathService: { list: () => [] },
    pipelineRegistry: { get: () => undefined, list: () => [] },
    presetRegistry: { list: () => [] },
    packs: { validPacks: [] },
    config: { projectName: 'fixture' },
  } as never;
}
