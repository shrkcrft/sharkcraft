import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { runArchCheck } from '@shrkcrft/architecture-guard';
import { FrameworkQueryApi } from '@shrkcrft/framework-scanners';
import { detectGraphFreshness, GraphQueryApi, GraphStore } from '@shrkcrft/graph';
import {
  findResumePoint,
  type IMigrationRunReport,
} from '@shrkcrft/migrate';
import { QualityGateReportStore, runQualityGates } from '@shrkcrft/quality-gates';
import { BridgeStore } from '@shrkcrft/rule-graph';
import type {
  IDashboardCodeIntelligenceResponse,
  IDashboardGraphHub,
  IDashboardMigrationRow,
  IDashboardMigrationsResponse,
  IDashboardQualityGate,
  IDashboardQualityGatesResponse,
  IDashboardRoutesResponse,
  IDashboardRouteRow,
} from '@shrkcrft/dashboard-api';

/**
 * Build the Code Intelligence overview response.
 *
 * Reads the three on-disk stores plus runs the architecture-guard
 * check inline. Every section degrades to `available: false` with a
 * `hint` when its backing store is missing — the dashboard renders
 * those as "run `shrk graph index` to enable" cards rather than
 * blocking the whole panel.
 *
 * Pure read — never builds or writes anything.
 */
export function buildDashboardCodeIntelligence(projectRoot: string): IDashboardCodeIntelligenceResponse {
  const commandHints = [
    { label: 'Build code graph', command: 'shrk graph index', purpose: 'Refresh the persistent code-graph store.' },
    { label: 'Build rule-graph bridge', command: 'shrk rule-graph index', purpose: 'Rebuild bridge edges from files to assets.' },
    { label: 'Build framework index', command: 'shrk framework index', purpose: 'Detect framework entities (NestJS, React, etc.).' },
    { label: 'Run architecture checks', command: 'shrk arch check', purpose: 'Surface public-API misuse, cycles, fat barrels.' },
  ];

  // Graph.
  const graphStore = new GraphStore(projectRoot);
  const graph: IDashboardCodeIntelligenceResponse['graph'] = graphStore.exists()
    ? readGraphSection(graphStore, projectRoot)
    : { available: false, hint: "run 'shrk graph index'" };

  // Bridge.
  const bridgeStore = new BridgeStore(projectRoot);
  const bridge: IDashboardCodeIntelligenceResponse['bridge'] = bridgeStore.exists()
    ? readBridgeSection(bridgeStore)
    : { available: false, hint: "run 'shrk rule-graph index'" };

  // Framework.
  const framework: IDashboardCodeIntelligenceResponse['framework'] = FrameworkQueryApi.missingDescription(projectRoot)
    ? { available: false, hint: "run 'shrk framework index'" }
    : readFrameworkSection(projectRoot);

  // Architecture (depends on graph store existing).
  const architecture: IDashboardCodeIntelligenceResponse['architecture'] = graph.available
    ? readArchSection(projectRoot)
    : { available: false, errors: 0, warnings: 0, hint: 'graph index missing' };

  return {
    schema: 'sharkcraft.dashboard-code-intelligence/v1',
    available: graph.available || bridge.available || framework.available,
    graph,
    bridge,
    framework,
    architecture,
    commandHints,
  };
}

/**
 * Build the cross-framework routes panel response.
 *
 * Reads the framework store. For each entity with `subtype: 'route'`
 * (or `api-route`), emits a row with `framework`, `method`, `path`,
 * `handler`, and `file`. Sorted alphabetically by (framework, method,
 * path).
 */
export function buildDashboardRoutes(projectRoot: string): IDashboardRoutesResponse {
  const commandHints = [
    { label: 'Build framework index', command: 'shrk framework index', purpose: 'Detect routes / components across frameworks.' },
    { label: 'List a single framework', command: 'shrk framework list --framework <name>', purpose: 'Filter the entity list to one framework.' },
  ];
  const missing = FrameworkQueryApi.missingDescription(projectRoot);
  if (missing) {
    return {
      schema: 'sharkcraft.dashboard-routes/v1',
      available: false,
      total: 0,
      byFramework: {},
      routes: [],
      commandHints,
      hint: missing,
    };
  }
  const api = FrameworkQueryApi.fromStore(projectRoot);
  const rows: IDashboardRouteRow[] = [];
  for (const entity of api.list({ subtype: 'route', limit: 5000 })) {
    rows.push(toRow(entity));
  }
  for (const entity of api.list({ subtype: 'api-route', limit: 5000 })) {
    rows.push(toRow(entity));
  }
  rows.sort(
    (a, b) =>
      a.framework.localeCompare(b.framework) ||
      a.method.localeCompare(b.method) ||
      a.path.localeCompare(b.path),
  );
  const byFramework: Record<string, number> = {};
  for (const r of rows) byFramework[r.framework] = (byFramework[r.framework] ?? 0) + 1;
  return {
    schema: 'sharkcraft.dashboard-routes/v1',
    available: true,
    total: rows.length,
    byFramework,
    routes: rows,
    commandHints,
  };
}

function readGraphSection(
  store: GraphStore,
  projectRoot: string,
): IDashboardCodeIntelligenceResponse['graph'] {
  const snap = store.loadSnapshot();
  const api = new GraphQueryApi(snap);
  const hubs = api.topHubs(8);
  const toRow = (h: { node: { id: string; label: string; path?: string }; inDegree: number }): IDashboardGraphHub => ({
    id: h.node.id,
    label: h.node.label,
    ...(h.node.path ? { path: h.node.path } : {}),
    inDegree: h.inDegree,
  });
  // Freshness vs the working tree — the same signal `shrk graph status` reports.
  // `corrupt` (store self-integrity) outranks `stale` (disk drift): a digest
  // failure means the counts themselves can't be trusted.
  const fresh = detectGraphFreshness(projectRoot);
  const behind = fresh.modified.length + fresh.added.length + fresh.deleted.length;
  const verify = store.verifyDigest();
  const state: 'fresh' | 'stale' | 'corrupt' = !verify.ok ? 'corrupt' : behind > 0 ? 'stale' : 'fresh';
  return {
    available: true,
    fileCount: snap.manifest.filesIndexed,
    nodeCount: snap.nodes.size,
    edgeCount: snap.edges.size,
    workspacePackages: snap.manifest.workspacePackages.length,
    lastIndexedAt: snap.manifest.lastIndexedAt,
    nodesByKind: snap.manifest.nodesByKind,
    edgesByKind: snap.manifest.edgesByKind,
    freshness: {
      state,
      modified: fresh.modified.length,
      added: fresh.added.length,
      deleted: fresh.deleted.length,
    },
    hubs: { symbols: hubs.symbols.map(toRow), files: hubs.files.map(toRow) },
  };
}

function readBridgeSection(store: BridgeStore): IDashboardCodeIntelligenceResponse['bridge'] {
  const snap = store.loadSnapshot();
  return {
    available: true,
    lastBuiltAt: snap.manifest.lastBuiltAt,
    nodesByKind: snap.manifest.nodesByKind,
    edgesByKind: snap.manifest.edgesByKind,
    sourceCounts: snap.manifest.sourceCounts,
  };
}

function readFrameworkSection(projectRoot: string): IDashboardCodeIntelligenceResponse['framework'] {
  const api = FrameworkQueryApi.fromStore(projectRoot);
  const manifest = api.manifest();
  return {
    available: true,
    lastBuiltAt: manifest.lastBuiltAt,
    frameworks: manifest.frameworks,
    countsByFramework: manifest.countsByFramework,
    countsBySubtype: manifest.countsBySubtype,
  };
}

function readArchSection(projectRoot: string): IDashboardCodeIntelligenceResponse['architecture'] {
  // Honor an optional `sharkcraft/arch.ts` if present, but never load
  // it dynamically inside the dashboard request path — keeping HTTP
  // handlers synchronous and avoiding arbitrary code execution under
  // the request. Default checks only.
  const archPath = nodePath.join(projectRoot, 'sharkcraft', 'arch.ts');
  void archPath;
  const report = runArchCheck({ projectRoot });
  return {
    available: report.diagnostics.length === 0 || !report.diagnostics.some((d) => d.includes('code-graph store missing')),
    errors: report.countsBySeverity.error,
    warnings: report.countsBySeverity.warning,
    violationsByKind: report.countsByKind,
  };
}

function toRow(entity: {
  data?: Readonly<Record<string, unknown>>;
  path?: string;
}): IDashboardRouteRow {
  const data = entity.data ?? {};
  return {
    framework: String(data['framework'] ?? '?'),
    method: String(data['method'] ?? '?'),
    path: String(data['path'] ?? data['routePath'] ?? '/'),
    handler: String(
      data['handler'] ??
        (data['className'] && data['handler']
          ? `${data['className']}.${data['handler']}`
          : data['name'] ?? '?'),
    ),
    file: entity.path ?? '?',
  };
}

/**
 * Build the Migrations panel response.
 *
 * Reads every `.sharkcraft/migrations/*.state.json` (written by
 * `@shrkcrft/migrate` after each step), shapes each into a dashboard
 * row, and stamps `resumePoint` so the UI can highlight where a
 * partially-failed migration would pick up.
 */
export function buildDashboardMigrations(projectRoot: string): IDashboardMigrationsResponse {
  const commandHints = [
    {
      label: 'Plan a migration',
      command: 'shrk migrate plan <id>',
      purpose: 'Preview the migration before any disk writes.',
    },
    {
      label: 'Apply a migration',
      command: 'shrk migrate apply <id>',
      purpose: 'Execute the migration; checkpoints are written after every step.',
    },
    {
      label: 'Resume a halted migration',
      command: 'shrk migrate resume <id>',
      purpose: 'Pick up at the failed step using the saved checkpoint.',
    },
  ];
  const dir = nodePath.join(projectRoot, '.sharkcraft', 'migrations');
  if (!existsSync(dir)) {
    return {
      schema: 'sharkcraft.dashboard-migrations/v1',
      available: false,
      total: 0,
      migrations: [],
      commandHints,
      hint: 'no migrations have been run yet',
    };
  }
  const rows: IDashboardMigrationRow[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('.state.json')) continue;
    const abs = nodePath.join(dir, entry);
    try {
      const report = JSON.parse(readFileSync(abs, 'utf8')) as IMigrationRunReport;
      const resumePoint = findResumePoint(report);
      rows.push({
        id: report.migration.id,
        title: report.migration.title,
        overall: report.overall,
        dryRun: report.dryRun,
        startedAt: report.startedAt,
        totalDurationMs: report.totalDurationMs,
        steps: report.steps.map((s) => ({
          index: s.index,
          id: s.id,
          kind: s.kind,
          status: s.status,
          message: s.message,
          durationMs: s.durationMs,
        })),
        ...(resumePoint !== undefined ? { resumePoint } : {}),
      });
    } catch {
      /* corrupted state file — skip silently */
    }
  }
  rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    schema: 'sharkcraft.dashboard-migrations/v1',
    available: true,
    total: rows.length,
    migrations: rows,
    commandHints,
  };
}

/**
 * Build the Quality-Gates panel response.
 *
 * Runs `runQualityGates` on request — the gate is cheap enough
 * (<500 ms on a medium repo) that a fresh run beats stale data. The
 * graph-fresh gate inside will surface "run `shrk graph index`" as a
 * `nextCommand` when the store is missing, so the panel degrades
 * gracefully.
 */
const QUALITY_GATE_REPORT_FRESH_MS = 5 * 60 * 1000;

export function buildDashboardQualityGates(projectRoot: string): IDashboardQualityGatesResponse {
  const commandHints = [
    {
      label: 'Run the gate locally',
      command: 'shrk gate',
      purpose: 'Same as the panel — writes a fresh .sharkcraft/quality-gates/last.json.',
    },
    {
      label: 'Fail on warnings too',
      command: 'shrk gate --strict',
      purpose: 'Make `warn` exit 1 (useful for CI).',
    },
  ];

  // Prefer a recent persisted report (written by `shrk gate`) over
  // running every gate on every page load — the gate is cheap but the
  // dashboard's polling loop is not.
  const store = new QualityGateReportStore(projectRoot);
  const saved = store.read();
  const savedAge = store.ageMs();
  const isFresh = saved !== undefined && savedAge !== undefined && savedAge <= QUALITY_GATE_REPORT_FRESH_MS;
  const report = isFresh ? saved! : runQualityGates({ projectRoot });
  if (!isFresh) {
    // Cache the freshly-computed report so subsequent dashboard
    // requests reuse it.
    try {
      store.write(report);
    } catch {
      /* best effort */
    }
  }
  const gates: IDashboardQualityGate[] = report.gates.map((g) => ({
    id: g.id,
    label: g.label,
    status: g.status,
    message: g.message,
    durationMs: g.durationMs,
    ...(g.nextCommands && g.nextCommands.length > 0 ? { nextCommands: g.nextCommands } : {}),
  }));
  return {
    schema: 'sharkcraft.dashboard-quality-gates/v1',
    overall: report.overall,
    startedAt: report.startedAt,
    totalDurationMs: report.totalDurationMs,
    counts: report.counts,
    gates,
    commandHints,
  };
}

void statSync;
