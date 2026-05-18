/**
 * Dashboard data service. Functions return plain JSON-compatible payloads —
 * never start an HTTP server, never call out to the network. The dashboard
 * API server wraps these with @shrkcrft/dashboard-api envelopes.
 *
 * Each builder:
 *  - catches expected missing-file cases and reports them as `warnings`
 *  - returns `available: false` when a feature has no data yet
 *  - includes copyable CLI command hints
 *  - includes safety metadata where relevant
 */
import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  IDashboardAdoptionResponse,
  IDashboardArchitectureResponse,
  IDashboardBoundaryResponse,
  IDashboardCapabilitiesResponse,
  IDashboardCommandsResponse,
  IDashboardCoverageResponse,
  IDashboardDoctorResponse,
  IDashboardDriftResponse,
  IDashboardGraphNodeResponse,
  IDashboardGraphPathResponse,
  IDashboardGraphResponse,
  IDashboardHealthResponse,
  IDashboardMcpResponse,
  IDashboardOnboardingResponse,
  IDashboardOverviewResponse,
  IDashboardPacksResponse,
  IDashboardPipelinesResponse,
  IDashboardPresetsResponse,
  IDashboardQualityResponse,
  IDashboardReportsResponse,
  IDashboardReviewResponse,
  IDashboardSafetyResponse,
  IDashboardScaffoldsResponse,
  IDashboardSchemasResponse,
  IDashboardSessionDetailResponse,
  IDashboardSessionsResponse,
  IDashboardStatsResponse,
  IDashboardArtifactRef,
  IDashboardCommandHint,
  DashboardSafetyLevel,
} from '@shrkcrft/dashboard-api';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildAiReadinessReport } from '../ai-readiness.ts';
import { runDoctor } from '../sharkcraft-inspector.ts';
import { DoctorSeverity } from '../doctor-result.ts';
import { buildCoverageReport } from '../coverage-report.ts';
import { buildDriftReport } from '../drift.ts';
import { buildKnowledgeGraph, findGraphPath, getGraphNode } from '../knowledge-graph.ts';
import { buildOnboardingPlan } from '../onboarding.ts';
import {
  ADOPTION_STATE_SCHEMA,
  adoptionDir,
  computeAdoptionFreshness,
  readAdoptionState,
} from '../adoption-state.ts';
import { listDevSessionsDetailed, scanDevSession } from '../dev-session.ts';
import { loadScaffoldPatternsFromInspection } from '../scaffold-patterns.ts';
import { buildQualityReport, type IQualityConfig } from '../quality-report.ts';
import { buildSafetyAudit } from '../safety-audit.ts';
import { buildRepositoryStats } from '../repository-stats.ts';

/* -------------------------------------------------------------------------- */
/* shared helpers                                                              */
/* -------------------------------------------------------------------------- */

function artifactRef(
  id: string,
  path: string,
  opts?: { title?: string; format?: IDashboardArtifactRef['format'] },
): IDashboardArtifactRef {
  let exists = false;
  let bytes: number | undefined;
  let modifiedAt: string | undefined;
  try {
    const st = statSync(path);
    exists = true;
    bytes = st.size;
    modifiedAt = st.mtime.toISOString();
  } catch {
    exists = false;
  }
  const ref: IDashboardArtifactRef = { id, path, exists };
  if (bytes !== undefined) (ref as { bytes?: number }).bytes = bytes;
  if (modifiedAt !== undefined) (ref as { modifiedAt?: string }).modifiedAt = modifiedAt;
  if (opts?.title) (ref as { title?: string }).title = opts.title;
  if (opts?.format) (ref as { format?: IDashboardArtifactRef['format'] }).format = opts.format;
  return ref;
}

function commandHint(
  command: string,
  purpose: string,
  safety?: DashboardSafetyLevel,
): IDashboardCommandHint {
  return safety ? { command, purpose, safety } : { command, purpose };
}

function mapSafetyLevel(level: string): DashboardSafetyLevel {
  switch (level) {
    case 'read-only':
    case 'writes-drafts':
    case 'writes-source':
    case 'runs-shell':
      return level;
    case 'writes-session':
      return 'writes-drafts';
    case 'requires-review':
      return 'writes-source';
    default:
      return 'unknown';
  }
}

function mapDoctorSeverity(s: DoctorSeverity): 'ok' | 'info' | 'warning' | 'error' {
  switch (s) {
    case DoctorSeverity.Ok:
      return 'ok';
    case DoctorSeverity.Info:
      return 'info';
    case DoctorSeverity.Warning:
      return 'warning';
    case DoctorSeverity.Error:
      return 'error';
    default:
      return 'info';
  }
}

/* -------------------------------------------------------------------------- */
/* overview / doctor                                                            */
/* -------------------------------------------------------------------------- */

export async function buildDashboardOverview(
  inspection: ISharkcraftInspection,
): Promise<IDashboardOverviewResponse> {
  const readiness = buildAiReadinessReport(inspection);
  const scaffolds = await loadScaffoldPatternsFromInspection(inspection);
  return {
    readiness: { score: readiness.score, verdict: readiness.grade },
    sharkcraftPresent: inspection.hasSharkcraftFolder,
    configPresent: inspection.configFile != null,
    summary: {
      rules: inspection.ruleService.list().length,
      paths: inspection.pathService.list().length,
      templates: inspection.templateRegistry.list().length,
      pipelines: inspection.pipelineRegistry.list().length,
      presets: inspection.presetRegistry.list().length,
      packs: inspection.packs.discoveredPacks.length,
      scaffoldPatterns: scaffolds.patterns.length,
      knowledgeEntries: inspection.knowledgeEntries.length,
    },
    topRecommendations: readiness.topRecommendations.slice(0, 5),
    featureAvailability: {
      adoption: existsSync(nodePath.join(inspection.projectRoot, 'sharkcraft', 'onboarding', 'adoption')),
      onboarding: existsSync(nodePath.join(inspection.projectRoot, 'sharkcraft', 'onboarding')),
      sessions: existsSync(nodePath.join(inspection.projectRoot, '.sharkcraft', 'sessions')),
      packs: inspection.packs.discoveredPacks.length > 0,
      presets: inspection.presetRegistry.list().length > 0,
      scaffolds: scaffolds.patterns.length > 0,
    },
  };
}

export function buildDashboardDoctor(inspection: ISharkcraftInspection): IDashboardDoctorResponse {
  const doctor = runDoctor(inspection);
  const checks = doctor.checks.map((c) => {
    const level = mapDoctorSeverity(c.severity);
    return {
      id: c.id,
      label: c.title,
      level,
      ...(c.message ? { message: c.message } : {}),
      ...(c.fix ? { fix: c.fix } : {}),
    };
  });
  return {
    verdict: doctor.passed ? 'ready' : 'not-ready',
    readinessScore: buildAiReadinessReport(inspection).score,
    checks,
    summary: doctor.summary,
  };
}

/* -------------------------------------------------------------------------- */
/* quality / safety                                                             */
/* -------------------------------------------------------------------------- */

export async function buildDashboardQuality(
  inspection: ISharkcraftInspection,
  options?: { qualityConfig?: IQualityConfig },
): Promise<IDashboardQualityResponse> {
  const report = await buildQualityReport({
    inspection,
    config: options?.qualityConfig ?? {},
    skipShell: true,
  });
  return {
    score: report.score,
    readiness: report.overall,
    gates: report.gates.map((g) => ({
      id: g.id,
      status: (g.passed ? 'pass' : g.blocking ? 'fail' : 'warn') as 'pass' | 'warn' | 'fail' | 'skipped',
      ...(g.notes && g.notes.length > 0 ? { message: g.notes.join('; ') } : {}),
    })),
    blockers: report.gates.filter((g) => !g.passed && g.blocking).map((g) => g.label),
    warnings: report.gates.filter((g) => !g.passed && !g.blocking).map((g) => g.label),
    artifacts: [],
    commandHints: [
      commandHint('shrk report quality --format html --output ./quality.html', 'Render the polished HTML report', 'read-only'),
      commandHint('shrk quality --json', 'Get the raw JSON for CI', 'read-only'),
    ],
  };
}

export function buildDashboardSafety(
  inspection: ISharkcraftInspection,
  catalog: ReadonlyArray<{
    command: string;
    description: string;
    category: string;
    safetyLevel: string;
    writesFiles: boolean;
    writesSource: boolean;
    runsShell: boolean;
    requiresReview: boolean;
    mcpAvailable: boolean;
  }>,
  mcpTools: ReadonlyArray<{ name: string; description: string }>,
): IDashboardSafetyResponse {
  const audit = buildSafetyAudit({
    inspection,
    catalog,
    mcpTools,
  });
  return {
    mcpReadOnly: !audit.mcp.anyWritable,
    writeCapableCommands: audit.commands.writesSource
      .concat(audit.commands.writesDrafts)
      .concat(audit.commands.writesSession)
      .map((c) => c.command),
    shellRunningCommands: audit.commands.runsShell.map((c) => c.command),
    verificationCommandTrust:
      audit.verifications.pack.length > 0
        ? 'mixed'
        : audit.verifications.untrusted.length > 0
          ? 'pack-untrusted'
          : 'config-only',
    packSigning: {
      required: false,
      verified: audit.packs.signedAndVerified,
      unsigned: audit.packs.unsigned,
    },
    planSigning: {
      verifySignatureSupported: true,
      hmacBased: true,
    },
    recommendations: [...audit.recommendations],
    safetyTags: [],
  };
}

/* -------------------------------------------------------------------------- */
/* commands / packs / presets / pipelines                                       */
/* -------------------------------------------------------------------------- */

export function buildDashboardCommands(
  catalog: ReadonlyArray<{ command: string; description: string; category: string; safetyLevel: string }>,
): IDashboardCommandsResponse {
  const groups = new Map<string, string>();
  for (const c of catalog) groups.set(c.category, c.category);
  return {
    version: '1',
    commands: catalog.map((c) => ({
      id: c.command,
      name: c.command,
      description: c.description,
      safety: { level: mapSafetyLevel(c.safetyLevel) },
      group: c.category,
    })),
    groups: Array.from(groups.entries()).map(([id, label]) => ({ id, label })),
  };
}

export function buildDashboardPacks(inspection: ISharkcraftInspection): IDashboardPacksResponse {
  const packs = inspection.packs.discoveredPacks.map((p) => {
    const counts = (p.resolvedCounts ?? p.contributionCounts ?? {}) as Record<string, number>;
    return {
      id: p.packageName,
      name: p.packageName,
      version: p.packageVersion,
      signed: p.signatureStatus === 'verified',
      resolvedCounts: counts as Readonly<Record<string, number>>,
      source: p.packageName,
      warnings: p.validationIssues.map((v) => `${v.field}: ${v.message}`),
    };
  });
  return { available: packs.length > 0, packs };
}

export function buildDashboardPresets(inspection: ISharkcraftInspection): IDashboardPresetsResponse {
  const presets = inspection.presetRegistry.list().map((p) => {
    const src = inspection.presetSources.get(p.id);
    const out: IDashboardPresetsResponse['presets'][number] = {
      id: p.id,
      title: p.title ?? p.id,
      ...(p.description ? { description: p.description } : {}),
      ...(src ? { source: src.packageName ?? src.type } : {}),
    };
    return out;
  });
  return { available: presets.length > 0, presets };
}

export function buildDashboardPipelines(inspection: ISharkcraftInspection): IDashboardPipelinesResponse {
  const pipelines = inspection.pipelineRegistry.list().map((p) => ({
    id: p.id,
    title: p.title ?? p.id,
    steps: Array.isArray(p.steps) ? p.steps.length : 0,
  }));
  return { available: pipelines.length > 0, pipelines };
}

/* -------------------------------------------------------------------------- */
/* sessions                                                                     */
/* -------------------------------------------------------------------------- */

export function buildDashboardSessions(projectRoot: string): IDashboardSessionsResponse {
  try {
    const items = listDevSessionsDetailed(projectRoot);
    return {
      available: true,
      sessions: items.map((it) => {
        const out: IDashboardSessionsResponse['sessions'][number] = { id: it.id };
        if (it.task) (out as { task?: string }).task = it.task;
        if (it.phase) (out as { status?: string }).status = it.phase;
        if (it.createdAt) (out as { startedAt?: string }).startedAt = it.createdAt;
        return out;
      }),
    };
  } catch {
    return { available: false, sessions: [] };
  }
}

export function buildDashboardSessionDetail(
  projectRoot: string,
  sessionId: string,
): IDashboardSessionDetailResponse {
  const load = scanDevSession(projectRoot, sessionId);
  if (!load) {
    return {
      available: false,
      sessionId,
      artifacts: [],
      commandHints: [commandHint(`shrk dev list`, 'List known sessions', 'read-only')],
    };
  }
  const sessionDir = nodePath.join(projectRoot, '.sharkcraft', 'sessions', sessionId);
  const artifacts: IDashboardArtifactRef[] = [];
  artifacts.push(artifactRef('session-state', nodePath.join(sessionDir, 'session.json'), { format: 'json' }));
  for (const r of load.reportsOnDisk) {
    artifacts.push(artifactRef(`report-${r}`, nodePath.join(sessionDir, 'reports', r)));
  }
  const detail: IDashboardSessionDetailResponse = {
    available: true,
    sessionId,
    task: load.task,
    artifacts,
    plans: load.plansOnDisk.map((p) => ({ id: p, path: nodePath.join(sessionDir, 'plans', p) })),
    commandHints: [
      commandHint(
        `shrk dev open ${sessionId} --serve --live --port 0`,
        'Open the session HTML report and watch updates',
        'read-only',
      ),
      commandHint(
        `shrk report session ${sessionId} --format html --output ./session.html`,
        'Render a standalone HTML report',
        'read-only',
      ),
    ],
  };
  if (load.state) {
    (detail as { status?: string }).status = load.state.phase;
    (detail as { startedAt?: string }).startedAt = load.state.createdAt;
  }
  return detail;
}

/* -------------------------------------------------------------------------- */
/* architecture / graph                                                         */
/* -------------------------------------------------------------------------- */

export function buildDashboardArchitecture(inspection: ISharkcraftInspection): IDashboardArchitectureResponse {
  return {
    available: true,
    boundaries: buildDashboardBoundaries(inspection),
    drift: buildDashboardDrift(inspection),
    coverage: buildDashboardCoverage(inspection),
  };
}

export function buildDashboardBoundaries(inspection: ISharkcraftInspection): IDashboardBoundaryResponse {
  const rules = inspection.boundaryRegistry.list();
  return {
    available: rules.length > 0,
    violations: [],
    ruleCount: rules.length,
  };
}

export function buildDashboardDrift(inspection: ISharkcraftInspection): IDashboardDriftResponse {
  const drift = buildDriftReport(inspection);
  return {
    available: true,
    items: drift.findings.map((f, idx) => ({
      id: `${f.category}-${idx}`,
      kind: f.category,
      message: f.message,
      severity: f.severity,
    })),
  };
}

export function buildDashboardCoverage(inspection: ISharkcraftInspection): IDashboardCoverageResponse {
  const coverage = buildCoverageReport(inspection);
  return {
    available: true,
    axes: coverage.categories.map((c) => ({
      id: c.id,
      label: c.title,
      score: c.score,
      missing: c.missing,
    })),
  };
}

export function buildDashboardGraph(inspection: ISharkcraftInspection): IDashboardGraphResponse {
  const graph = buildKnowledgeGraph(inspection);
  return {
    available: true,
    nodes: graph.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.title })),
    edges: graph.edges.map((e) => ({ from: e.from, to: e.to, kind: e.relation })),
  };
}

export function buildDashboardGraphNode(
  inspection: ISharkcraftInspection,
  id: string,
): IDashboardGraphNodeResponse {
  const graph = buildKnowledgeGraph(inspection);
  const result = getGraphNode(graph, { id });
  if (!result || !result.node) {
    return { id, found: false, inbound: [], outbound: [] };
  }
  return {
    id,
    found: true,
    node: { id: result.node.id, kind: result.node.kind, label: result.node.title },
    inbound: result.incoming.map((e) => ({ from: e.from, kind: e.relation })),
    outbound: result.outgoing.map((e) => ({ to: e.to, kind: e.relation })),
  };
}

export function buildDashboardGraphPath(
  inspection: ISharkcraftInspection,
  from: string,
  to: string,
): IDashboardGraphPathResponse {
  const graph = buildKnowledgeGraph(inspection);
  const result = findGraphPath(graph, { id: from }, { id: to });
  if (!result.found) return { from, to, found: false };
  return {
    from,
    to,
    found: true,
    path: result.steps.map((s) => s.node),
    ...(result.reason ? { explanation: result.reason } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* onboarding / adoption                                                        */
/* -------------------------------------------------------------------------- */

export function buildDashboardOnboarding(
  inspection: ISharkcraftInspection,
): IDashboardOnboardingResponse {
  const plan = buildOnboardingPlan(inspection);
  const draftsDir = nodePath.join(inspection.projectRoot, 'sharkcraft', 'onboarding', 'drafts');
  return {
    available: true,
    draftsPath: draftsDir,
    hasDrafts: existsSync(draftsDir),
    summary: {
      inferredRules: plan.inferredRules.length,
      inferredPaths: plan.inferredPathConventions.length,
      inferredTemplates: plan.inferredTemplateCandidates.length,
      importedAgents: plan.detectedInstructionFiles.length,
    },
    commandHints: [
      commandHint('shrk onboard --dry-run', 'Preview onboarding output without writing', 'read-only'),
      commandHint('shrk onboard --write-drafts', 'Write inferred drafts under sharkcraft/onboarding/', 'writes-drafts'),
    ],
  };
}

export function buildDashboardAdoption(
  inspection: ISharkcraftInspection,
): IDashboardAdoptionResponse {
  const state = readAdoptionState(inspection.projectRoot);
  const artifacts: IDashboardArtifactRef[] = [];
  if (state) {
    if (state.patchPath) artifacts.push(artifactRef('adoption-patch', state.patchPath, { format: 'patch' }));
    if (state.summaryPath) artifacts.push(artifactRef('adoption-summary', state.summaryPath, { format: 'markdown' }));
    if (state.reportPath) artifacts.push(artifactRef('adoption-report', state.reportPath, { format: 'html' }));
  }
  const nextCommands: IDashboardCommandHint[] = [];
  if (!state) {
    nextCommands.push(
      commandHint('shrk onboard --write-drafts', 'Generate onboarding drafts first', 'writes-drafts'),
      commandHint('shrk onboard adopt --write-patch', 'Build the first adoption patch', 'writes-drafts'),
    );
    return { available: false, nextCommands, artifacts };
  }

  const freshness = computeAdoptionFreshness(inspection.projectRoot, state);

  if (freshness.status !== 'fresh') {
    nextCommands.push(
      commandHint('shrk onboard adopt regenerate', 'Regenerate the adoption patch from current state', 'writes-drafts'),
    );
  }
  nextCommands.push(
    commandHint('shrk onboard adopt status', 'Inspect adoption freshness', 'read-only'),
    commandHint('shrk onboard adopt merge-preview --format markdown', 'See what would change before applying', 'read-only'),
    commandHint('shrk onboard adopt check', 'Validate the patch can be applied', 'read-only'),
  );

  return {
    available: true,
    state: {
      schema: ADOPTION_STATE_SCHEMA,
      patchPath: state.patchPath,
      summaryPath: state.summaryPath,
      ...(state.reportPath ? { reportPath: state.reportPath } : {}),
      diffFormat: state.diffFormat,
      freshness: {
        status: freshness.status as 'fresh' | 'stale' | 'unknown',
        staleReasons: [...freshness.staleReasons],
        changedTargets: freshness.changedTargets.map((f) => f.relativePath),
        changedDrafts: freshness.changedDrafts.map((f) => f.relativePath),
        missingTargets: [...freshness.missingTargets],
        missingDrafts: [...freshness.missingDrafts],
      },
      categories: {
        safeToAdopt: state.categories['safe-to-adopt']?.length ?? 0,
        manualReview: state.categories['manual-review']?.length ?? 0,
        lowConfidence: state.categories['low-confidence']?.length ?? 0,
        conflicts: state.categories['conflict']?.length ?? 0,
        alreadyCovered: state.categories['already-covered']?.length ?? 0,
        skipped: state.categories['skipped']?.length ?? 0,
      },
    },
    nextCommands,
    artifacts,
  };
}

/* -------------------------------------------------------------------------- */
/* reports / review / scaffolds                                                 */
/* -------------------------------------------------------------------------- */

export function buildDashboardReports(inspection: ISharkcraftInspection): IDashboardReportsResponse {
  const projectRoot = inspection.projectRoot;
  const sessionRoot = nodePath.join(projectRoot, '.sharkcraft', 'sessions');
  const adoptionRoot = adoptionDir(projectRoot);
  const reports = [
    {
      id: 'quality',
      title: 'Quality report',
      availableFormats: ['text', 'markdown', 'html', 'json'] as const,
      commandHint: 'shrk report quality --format html --output ./quality.html',
      artifacts: [] as IDashboardArtifactRef[],
    },
    {
      id: 'safety',
      title: 'Safety audit',
      availableFormats: ['text', 'markdown', 'html', 'json'] as const,
      commandHint: 'shrk report safety --format html --output ./safety.html',
      artifacts: [],
    },
    {
      id: 'adoption',
      title: 'Adoption report',
      availableFormats: ['text', 'markdown', 'html', 'json'] as const,
      commandHint: 'shrk report adoption --format html --output ./adoption.html',
      artifacts: existsSync(adoptionRoot) ? [artifactRef('adoption-dir', adoptionRoot)] : [],
    },
    {
      id: 'review',
      title: 'Review packet renderer',
      availableFormats: ['text', 'markdown', 'html', 'json'] as const,
      commandHint: 'shrk report review <packet.json> --format html --output ./review.html',
      artifacts: [],
    },
    {
      id: 'session',
      title: 'Dev session report',
      availableFormats: ['text', 'markdown', 'html', 'json'] as const,
      commandHint: 'shrk report session <id> --format html --output ./session.html',
      artifacts: existsSync(sessionRoot) ? [artifactRef('sessions-dir', sessionRoot)] : [],
    },
  ];
  return { available: true, reports };
}

export function buildDashboardReview(
  _inspection: ISharkcraftInspection,
  options?: { packetPath?: string },
): IDashboardReviewResponse {
  const path = options?.packetPath;
  if (!path) {
    return {
      available: false,
      affectedAreas: [],
      relevantRules: [],
      suggestedChecks: [],
      artifacts: [],
      commandHints: [
        commandHint('shrk review build --since main', 'Generate a review packet from a diff', 'read-only'),
      ],
    };
  }
  if (!existsSync(path)) {
    return {
      available: false,
      packetPath: path,
      affectedAreas: [],
      relevantRules: [],
      suggestedChecks: [],
      artifacts: [],
      commandHints: [],
    };
  }
  return {
    available: true,
    packetPath: path,
    affectedAreas: [],
    relevantRules: [],
    suggestedChecks: [],
    artifacts: [artifactRef('review-packet', path, { format: 'json' })],
    commandHints: [
      commandHint(`shrk report review ${path} --format html --output ./review.html`, 'Render the packet as HTML', 'read-only'),
    ],
  };
}

export async function buildDashboardScaffolds(inspection: ISharkcraftInspection): Promise<IDashboardScaffoldsResponse> {
  const result = await loadScaffoldPatternsFromInspection(inspection);
  return {
    available: result.patterns.length > 0,
    patterns: result.patterns.map((p) => ({
      id: p.pattern.id,
      title: p.pattern.title,
      templateId: p.pattern.templateId,
      source: p.source.packageName ?? p.source.type,
      confidence: p.pattern.confidence,
      matchPaths: [...p.pattern.matchPaths],
      appliesWhen: [...p.pattern.appliesWhen],
    })),
    warnings: [...result.warnings],
  };
}

/* -------------------------------------------------------------------------- */
/* schemas / mcp / health / capabilities                                       */
/* -------------------------------------------------------------------------- */

export function buildDashboardSchemas(): IDashboardSchemasResponse {
  return {
    schemas: [
      { id: 'sharkcraft.dashboard-api/v1', title: 'Dashboard API envelope' },
      { id: 'sharkcraft.adoption-state/v1', title: 'Adoption state' },
      { id: 'sharkcraft.adoption-summary/v1', title: 'Adoption summary' },
      { id: 'sharkcraft.adoption-merge-preview/v1', title: 'Adoption merge preview' },
      { id: 'sharkcraft.adoption-report/v1', title: 'Adoption report' },
      { id: 'sharkcraft.scaffold-pattern/v1', title: 'Scaffold pattern' },
      { id: 'sharkcraft.inferred-template-candidate/v2', title: 'Inferred template candidate (v2)' },
      { id: 'sharkcraft.dev-session/v1', title: 'Dev session state' },
      { id: 'sharkcraft.quality-report/v1', title: 'Quality report' },
      { id: 'sharkcraft.safety-audit/v1', title: 'Safety audit' },
    ],
  };
}

export function buildDashboardMcpSummary(
  toolNames: ReadonlyArray<{ name: string; description?: string }>,
): IDashboardMcpResponse {
  return {
    readOnly: true,
    transports: ['stdio', 'http'],
    tools: toolNames.map((t) => {
      const tool: IDashboardMcpResponse['tools'][number] = { name: t.name, readOnly: true };
      if (t.description) (tool as { description?: string }).description = t.description;
      return tool;
    }),
  };
}

export function buildDashboardHealth(uptimeSeconds: number): IDashboardHealthResponse {
  return {
    ok: true,
    readOnly: true,
    apiVersion: '1',
    schemaId: 'sharkcraft.dashboard-api/v1',
    uptimeSeconds,
    capabilitiesUrl: '/api/capabilities',
  };
}

export async function buildDashboardStats(
  cwd: string,
  opts?: { maxTopFiles?: number; language?: string },
): Promise<IDashboardStatsResponse> {
  const stats = await buildRepositoryStats({
    cwd,
    ...(opts?.maxTopFiles !== undefined ? { maxTopFiles: opts.maxTopFiles } : {}),
    ...(opts?.language ? { language: opts.language } : {}),
  });
  return {
    schema: stats.schema,
    generatedAt: stats.generatedAt,
    projectRoot: stats.projectRoot,
    totals: stats.totals,
    byLanguage: stats.byLanguage.map((l) => ({
      language: l.language,
      extensions: l.extensions,
      files: l.files,
      bytes: l.bytes,
      totalLines: l.totalLines,
      codeLines: l.codeLines,
      commentLines: l.commentLines,
      blankLines: l.blankLines,
      averageFileBytes: l.averageFileBytes,
      averageFileLines: l.averageFileLines,
      largestFile: l.largestFile,
    })),
    topFiles: stats.topFiles,
    ignoredDirectories: stats.ignoredDirectories,
    truncated: stats.truncated,
    commandHints: [
      commandHint('shrk stats', 'Refresh repository statistics from the CLI', 'read-only'),
      commandHint('shrk stats --json', 'Emit machine-readable stats', 'read-only'),
      commandHint('shrk stats --language typescript', 'Filter to a single language', 'read-only'),
    ],
  };
}

export function buildDashboardCapabilities(
  availability: Partial<IDashboardCapabilitiesResponse> = {},
): IDashboardCapabilitiesResponse {
  return {
    readOnly: true,
    supportsSessions: true,
    supportsQuality: true,
    supportsSafety: true,
    supportsAdoption: true,
    supportsScaffolds: true,
    supportsReports: true,
    supportsGraph: true,
    supportsReview: true,
    supportsPacks: true,
    supportsPresets: true,
    supportsPipelines: true,
    supportsMcpSummary: true,
    supportsLiveSessionEvents: true,
    writeEndpoints: [],
    dangerousActions: [],
    commandHints: [
      commandHint('shrk dashboard --serve', 'Start the local read-only dashboard API', 'read-only'),
      commandHint('shrk dev open <id> --serve --live --port 0', 'Open a live session view', 'read-only'),
    ],
    ...availability,
  };
}
