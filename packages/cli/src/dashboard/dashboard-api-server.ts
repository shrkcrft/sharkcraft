/**
 * Read-only local dashboard API server.
 *
 * Safety contract (must hold forever):
 *  - only GET and HEAD are allowed; everything else returns 405
 *  - no source writes — server reads inspection state and serves JSON
 *  - no apply / shell / onboard-write endpoints
 *  - binds 127.0.0.1 by default; a non-localhost host emits a loud warning
 *  - /api/health.readOnly === true
 *
 * This module is structured so the future `shrk dashboard --serve` command
 * and the in-process tests share the same handler.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildDashboardAdoption,
  buildDashboardArchitecture,
  buildDashboardBoundaries,
  buildDashboardCapabilities,
  buildDashboardCommands,
  buildDashboardCoverage,
  buildDashboardDoctor,
  buildDashboardDrift,
  buildDashboardGraph,
  buildDashboardGraphNode,
  buildDashboardGraphPath,
  buildDashboardHealth,
  buildDashboardMcpSummary,
  buildDashboardOnboarding,
  buildDashboardOverview,
  buildDashboardPacks,
  buildDashboardPipelines,
  buildDashboardPresets,
  buildDashboardQuality,
  buildDashboardReports,
  buildDashboardReview,
  buildDashboardSafety,
  buildDashboardScaffolds,
  buildDashboardSchemas,
  buildDashboardSessionDetail,
  buildDashboardSessions,
  buildDashboardStats,
  inspectSharkcraft,
  renderDevSessionHtml,
  scanDevSession,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import { COMMAND_CATALOG } from '../commands/command-catalog.ts';
import {
  buildDashboardCodeIntelligence,
  buildDashboardMigrations,
  buildDashboardQualityGates,
  buildDashboardRoutes,
} from './code-intelligence-data.ts';

const SCHEMA_ID = 'sharkcraft.dashboard-api/v1';

interface IServerOptions {
  cwd: string;
  host?: string;
  port?: number;
  /** Optional MCP tool list (passed in to avoid a CLI → MCP dependency). */
  mcpTools?: ReadonlyArray<{ name: string; description?: string }>;
  /** Directory containing built dashboard static assets. When absent, /<non-api> returns 404. */
  staticDir?: string | null;
}

interface IServerHandle {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Per-session SSE hub. One watcher tree per session id, shared across all
 * connected EventSource clients. Watchers are torn down when the last
 * subscriber disconnects.
 */
interface ISessionHub {
  subscribers: Set<(line: string) => void>;
  watchers: Array<{ close(): void }>;
  version: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Global SSE hub for project-wide store changes. Watches the
 * top-level `.sharkcraft/` directories that back the code-intelligence
 * stores so the dashboard auto-refreshes when an indexer runs.
 */
interface IGlobalHub {
  subscribers: Set<(line: string) => void>;
  watchers: Array<{ close(): void }>;
  version: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastEvent: string | null;
}

export async function startDashboardApiServer(opts: IServerOptions): Promise<IServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    process.stderr.write(
      `WARNING: --host ${host} exposes the dashboard API server beyond localhost. Press Ctrl+C to abort if unintended.\n`,
    );
  }
  const startedAt = Date.now();
  const sessionHubs = new Map<string, ISessionHub>();
  const ctx: IServerContext = { opts, startedAt, sessionHubs, globalHub: null };
  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, ctx);
    } catch (err) {
      respondError(res, 500, 'internal', (err as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const addr = server.address();
  const realPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://${host}:${realPort}`,
    host,
    port: realPort,
    close: () =>
      new Promise<void>((resolve) => {
        // Tear down every active SSE hub first.
        for (const hub of sessionHubs.values()) closeHub(hub);
        sessionHubs.clear();
        if (ctx.globalHub) {
          closeGlobalHub(ctx.globalHub);
          ctx.globalHub = null;
        }
        server.close(() => resolve());
      }),
  };
}

interface IServerContext {
  opts: IServerOptions;
  startedAt: number;
  sessionHubs: Map<string, ISessionHub>;
  globalHub: IGlobalHub | null;
}

function closeHub(hub: ISessionHub): void {
  if (hub.debounceTimer) {
    clearTimeout(hub.debounceTimer);
    hub.debounceTimer = null;
  }
  for (const w of hub.watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  hub.watchers = [];
  hub.subscribers.clear();
}

function ensureSessionHub(
  ctx: IServerContext,
  sessionId: string,
): ISessionHub {
  const existing = ctx.sessionHubs.get(sessionId);
  if (existing) return existing;
  const hub: ISessionHub = {
    subscribers: new Set(),
    watchers: [],
    version: 0,
    debounceTimer: null,
  };
  const sessionDir = nodePath.join(ctx.opts.cwd, '.sharkcraft', 'sessions', sessionId);
  const scheduleBroadcast = (event: string): void => {
    if (hub.debounceTimer) clearTimeout(hub.debounceTimer);
    hub.debounceTimer = setTimeout(() => {
      hub.version += 1;
      const line = `event: change\ndata: ${event}\nid: ${hub.version}\n\n`;
      for (const send of [...hub.subscribers]) {
        try {
          send(line);
        } catch {
          hub.subscribers.delete(send);
        }
      }
    }, 200);
  };
  for (const sub of ['session.json', 'plans', 'reports']) {
    const target = nodePath.join(sessionDir, sub);
    if (!fs.existsSync(target)) continue;
    try {
      const w = fs.watch(target, { recursive: true }, () => scheduleBroadcast(sub));
      hub.watchers.push(w);
    } catch {
      try {
        const w = fs.watch(target, () => scheduleBroadcast(sub));
        hub.watchers.push(w);
      } catch {
        /* ignore */
      }
    }
  }
  ctx.sessionHubs.set(sessionId, hub);
  return hub;
}

/**
 * Watched subdirectories under `.sharkcraft/` for the global hub.
 * Order matters only for diagnostics — the event emitted is `change:<name>`.
 *
 *   - `graph/`: the code-graph store; fires after `shrk graph index`.
 *   - `bridge/`: the rule-graph bridge.
 *   - `framework/`: framework-scanner outputs.
 *   - `migrations/`: migrate run state (one file per migration).
 *   - `api-surface/`: api-surface-diff caches.
 *   - `quality-gates/`: persisted gate reports.
 */
const GLOBAL_WATCH_DIRS = [
  'graph',
  'bridge',
  'framework',
  'migrations',
  'api-surface',
  'quality-gates',
] as const;

function closeGlobalHub(hub: IGlobalHub): void {
  if (hub.debounceTimer) {
    clearTimeout(hub.debounceTimer);
    hub.debounceTimer = null;
  }
  for (const w of hub.watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  hub.watchers = [];
  hub.subscribers.clear();
}

function ensureGlobalHub(ctx: IServerContext): IGlobalHub {
  if (ctx.globalHub) return ctx.globalHub;
  const hub: IGlobalHub = {
    subscribers: new Set(),
    watchers: [],
    version: 0,
    debounceTimer: null,
    lastEvent: null,
  };
  const broadcast = (name: string): void => {
    if (hub.debounceTimer) clearTimeout(hub.debounceTimer);
    hub.debounceTimer = setTimeout(() => {
      hub.version += 1;
      hub.lastEvent = name;
      const line = `event: change\ndata: ${name}\nid: ${hub.version}\n\n`;
      for (const send of [...hub.subscribers]) {
        try {
          send(line);
        } catch {
          hub.subscribers.delete(send);
        }
      }
    }, 200);
  };
  for (const dir of GLOBAL_WATCH_DIRS) {
    const target = nodePath.join(ctx.opts.cwd, '.sharkcraft', dir);
    if (!fs.existsSync(target)) continue;
    try {
      const w = fs.watch(target, { recursive: true }, () => broadcast(dir));
      hub.watchers.push(w);
    } catch {
      try {
        const w = fs.watch(target, () => broadcast(dir));
        hub.watchers.push(w);
      } catch {
        /* ignore */
      }
    }
  }
  ctx.globalHub = hub;
  return hub;
}

function serveGlobalEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: IServerContext,
): void {
  const hub = ensureGlobalHub(ctx);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive',
  });
  const send = (line: string): void => {
    res.write(line);
  };
  hub.subscribers.add(send);
  send(`event: hello\ndata: ${hub.lastEvent ?? 'ready'}\nid: ${hub.version}\n\n`);
  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 15000);
  const close = (): void => {
    clearInterval(ping);
    hub.subscribers.delete(send);
    if (hub.subscribers.size === 0) {
      closeGlobalHub(hub);
      ctx.globalHub = null;
    }
  };
  req.on('close', close);
  req.on('end', close);
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: IServerContext,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    return respondError(res, 405, 'method-not-allowed', `Method ${req.method} not allowed`);
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const opts = ctx.opts;
  const startedAt = ctx.startedAt;
  const projectRoot = opts.cwd;

  // Static assets — only when not /api/*. SPA fallback to index.html.
  if (!path.startsWith('/api/') && opts.staticDir) {
    return serveStatic(res, opts.staticDir, path);
  }

  // Session live events (SSE). Subscribe via EventSource on the session detail page.
  const sseMatch = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (sseMatch) {
    return serveSessionEvents(req, res, ctx, decodeURIComponent(sseMatch[1]!));
  }
  // Global live events (SSE). Subscribers refetch on every change.
  if (path === '/api/events') {
    return serveGlobalEvents(req, res, ctx);
  }

  // Rendered HTML report for the session (or any report on disk under the
  // session dir). Served with a content-security-policy that disallows
  // anything but inline styles — the report renderer never emits scripts,
  // but iframe sandboxing in the UI is the second line of defence.
  const reportMatch = path.match(/^\/api\/sessions\/([^/]+)\/report\.html$/);
  if (reportMatch) {
    return serveSessionReportHtml(res, ctx.opts.cwd, decodeURIComponent(reportMatch[1]!));
  }

  if (path === '/api/health') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardHealth(Math.floor((Date.now() - startedAt) / 1000))));
  }
  if (path === '/api/capabilities') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardCapabilities()));
  }
  if (path === '/api/commands') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardCommands(COMMAND_CATALOG)));
  }
  if (path === '/api/schemas') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardSchemas()));
  }
  if (path === '/api/mcp') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardMcpSummary(opts.mcpTools ?? [])));
  }
  if (path === '/api/reports') {
    const inspection = await inspectSharkcraft({ cwd: projectRoot });
    return respond(res, buildEnvelope(projectRoot, buildDashboardReports(inspection)));
  }
  if (path === '/api/stats') {
    const urlObj = new URL(req.url ?? '/', `http://${opts.host ?? '127.0.0.1'}`);
    const topStr = urlObj.searchParams.get('top');
    const language = urlObj.searchParams.get('language') ?? undefined;
    const maxTopFiles = topStr !== null ? Math.max(0, Number(topStr) || 0) : undefined;
    const stats = await buildDashboardStats(projectRoot, {
      ...(maxTopFiles !== undefined ? { maxTopFiles } : {}),
      ...(language ? { language } : {}),
    });
    return respond(res, buildEnvelope(projectRoot, stats));
  }
  if (path === '/api/code-intelligence') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardCodeIntelligence(projectRoot)));
  }
  if (path === '/api/routes') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardRoutes(projectRoot)));
  }
  if (path === '/api/migrations') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardMigrations(projectRoot)));
  }
  if (path === '/api/quality-gates') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardQualityGates(projectRoot)));
  }

  // For data routes that need inspection, load once per request.
  const needsInspection =
    path.startsWith('/api/overview') ||
    path.startsWith('/api/doctor') ||
    path.startsWith('/api/quality') ||
    path.startsWith('/api/safety') ||
    path.startsWith('/api/packs') ||
    path.startsWith('/api/presets') ||
    path.startsWith('/api/pipelines') ||
    path.startsWith('/api/architecture') ||
    path.startsWith('/api/graph') ||
    path.startsWith('/api/onboarding') ||
    path.startsWith('/api/review') ||
    path.startsWith('/api/scaffolds');
  const inspection: ISharkcraftInspection | null = needsInspection
    ? await inspectSharkcraft({ cwd: projectRoot })
    : null;

  if (path === '/api/overview') {
    return respond(res, buildEnvelope(projectRoot, await buildDashboardOverview(inspection!)));
  }
  if (path === '/api/doctor') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardDoctor(inspection!)));
  }
  if (path === '/api/quality') {
    return respond(res, buildEnvelope(projectRoot, await buildDashboardQuality(inspection!)));
  }
  if (path === '/api/safety') {
    return respond(
      res,
      buildEnvelope(
        projectRoot,
        buildDashboardSafety(
          inspection!,
          COMMAND_CATALOG,
          (opts.mcpTools ?? []).map((t) => ({ name: t.name, description: t.description ?? '' })),
        ),
      ),
    );
  }
  if (path === '/api/packs') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardPacks(inspection!)));
  }
  if (path === '/api/presets') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardPresets(inspection!)));
  }
  if (path === '/api/pipelines') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardPipelines(inspection!)));
  }
  if (path === '/api/architecture') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardArchitecture(inspection!)));
  }
  if (path === '/api/architecture/boundaries') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardBoundaries(inspection!)));
  }
  if (path === '/api/architecture/drift') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardDrift(inspection!)));
  }
  if (path === '/api/architecture/coverage') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardCoverage(inspection!)));
  }
  if (path === '/api/graph') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardGraph(inspection!)));
  }
  const nodeMatch = path.match(/^\/api\/graph\/node\/(.+)$/);
  if (nodeMatch) {
    return respond(
      res,
      buildEnvelope(projectRoot, buildDashboardGraphNode(inspection!, decodeURIComponent(nodeMatch[1]!))),
    );
  }
  if (path === '/api/graph/why') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to) return respondError(res, 400, 'bad-request', 'from and to query params required');
    return respond(res, buildEnvelope(projectRoot, buildDashboardGraphPath(inspection!, from, to)));
  }
  if (path === '/api/onboarding') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardOnboarding(inspection!)));
  }
  if (path === '/api/onboarding/adoption') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardAdoption(inspection!)));
  }
  if (path === '/api/scaffolds') {
    return respond(res, buildEnvelope(projectRoot, await buildDashboardScaffolds(inspection!)));
  }
  if (path === '/api/review') {
    return respond(
      res,
      buildEnvelope(projectRoot, buildDashboardReview(inspection!, { packetPath: url.searchParams.get('packet') ?? undefined })),
    );
  }
  if (path === '/api/sessions') {
    return respond(res, buildEnvelope(projectRoot, buildDashboardSessions(projectRoot)));
  }
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(\/report)?$/);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]!);
    const detail = buildDashboardSessionDetail(projectRoot, id);
    if (!detail.available) return respondError(res, 404, 'not-found', `Unknown session: ${id}`);
    return respond(res, buildEnvelope(projectRoot, detail));
  }

  return respondError(res, 404, 'not-found', `Unknown route: ${path}`);
}

function buildEnvelope<T>(projectRoot: string, data: T): { schema: string; generatedAt: string; projectRoot: string; data: T } {
  return {
    schema: SCHEMA_ID,
    generatedAt: new Date().toISOString(),
    projectRoot,
    data,
  };
}

function respond(res: http.ServerResponse, payload: unknown): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-sharkcraft-dashboard-api', '1');
  if ((res.req?.method ?? 'GET') === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload));
}

function respondError(
  res: http.ServerResponse,
  status: number,
  code: 'not-found' | 'method-not-allowed' | 'bad-request' | 'internal' | 'unavailable',
  message: string,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      schema: SCHEMA_ID,
      generatedAt: new Date().toISOString(),
      data: { error: message, code },
    }),
  );
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

function serveSessionEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: IServerContext,
  sessionId: string,
): void {
  // Confirm the session exists before subscribing watchers.
  const load = scanDevSession(ctx.opts.cwd, sessionId);
  if (!load) {
    return respondError(res, 404, 'not-found', `Unknown session: ${sessionId}`);
  }
  const hub = ensureSessionHub(ctx, sessionId);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive',
  });
  const send = (line: string): void => {
    res.write(line);
  };
  hub.subscribers.add(send);
  // Initial hello so the client knows the stream is open.
  send(`event: hello\ndata: ${sessionId}\nid: ${hub.version}\n\n`);
  // Keep-alive comment ping so proxies don't close the connection.
  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 15000);
  const close = (): void => {
    clearInterval(ping);
    hub.subscribers.delete(send);
    // If we're the last subscriber, tear the hub down so file watchers
    // don't outlive their clients.
    if (hub.subscribers.size === 0) {
      closeHub(hub);
      ctx.sessionHubs.delete(sessionId);
    }
  };
  req.on('close', close);
  req.on('end', close);
}

function serveSessionReportHtml(
  res: http.ServerResponse,
  cwd: string,
  sessionId: string,
): void {
  const load = scanDevSession(cwd, sessionId);
  if (!load) {
    return respondError(res, 404, 'not-found', `Unknown session: ${sessionId}`);
  }
  const html = renderDevSessionHtml(load, {
    nextActionLine: load.state?.nextAction ?? undefined,
  });
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  // Belt-and-braces: even though the renderer never emits scripts and the
  // dashboard wraps this in a sandboxed iframe, a CSP keeps any future
  // mishap from running JS.
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
  );
  if ((res.req?.method ?? 'GET') === 'HEAD') {
    res.end();
    return;
  }
  res.end(html);
}

function serveStatic(res: http.ServerResponse, staticDir: string, urlPath: string): void {
  // Strip leading / and resolve against staticDir. Reject traversal.
  const rel = urlPath.replace(/^\/+/, '');
  const abs = nodePath.resolve(staticDir, rel);
  if (!abs.startsWith(nodePath.resolve(staticDir))) {
    return respondError(res, 400, 'bad-request', 'invalid path');
  }
  let target = abs;
  try {
    const st = statSync(target);
    if (st.isDirectory()) target = nodePath.join(target, 'index.html');
  } catch {
    // Not found — SPA fallback to index.html for client-side routing.
    target = nodePath.join(staticDir, 'index.html');
  }
  if (!existsSync(target)) {
    return respondError(res, 404, 'not-found', 'asset not found');
  }
  const ext = nodePath.extname(target).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  const body = readFileSync(target);
  res.statusCode = 200;
  res.setHeader('content-type', mime);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  if (ext === '.html') {
    res.setHeader('cache-control', 'no-store');
  } else {
    res.setHeader('cache-control', 'public, max-age=3600');
  }
  if ((res.req?.method ?? 'GET') === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

export type { IServerHandle, IServerOptions };
