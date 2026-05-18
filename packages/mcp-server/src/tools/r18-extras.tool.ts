/**
 * API + boundaries MCP tools. All read-only.
 */
import {
  buildApiReport,
  buildDashboardExport,
  buildReposetMap,
  buildSafetyAuditDeep,
  buildUpgradeAdvice,
  computeReleaseTrainReadiness,
  generatePackDocs,
  getReleaseTrain,
  getRoleView,
  getTaskAwareRoleView,
  listReleaseTrains,
  listRoleViews,
  loadReposetConfig,
  recommendCommands,
  scorePack,
  suggestDiagnostic,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getRoleViewTool: IToolDefinition = {
  name: 'get_role_view',
  description:
    'Get a role-specific view (developer/reviewer/architect/release-manager/security/ai-agent). When `task` is supplied, the view is personalised with intent + per-task risk + role-appropriate commands.',
  inputSchema: {
    type: 'object',
    properties: {
      role: { type: 'string' },
      task: { type: 'string' },
      riskAware: { type: 'boolean' },
    },
    required: ['role'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const role = typeof input['role'] === 'string' ? (input['role'] as string) : '';
    const task = typeof input['task'] === 'string' ? (input['task'] as string).trim() : '';
    if (task.length > 0) {
      const v = await getTaskAwareRoleView(role, task, ctx.inspection);
      if (!v) {
        return {
          isError: true,
          error: { code: 'role-not-found', message: `Unknown role "${role}".`, details: { role, available: listRoleViews().map((x) => x.role) } },
        };
      }
      return { data: v };
    }
    const v = getRoleView(role);
    if (!v) {
      return {
        isError: true,
        error: { code: 'role-not-found', message: `Unknown role "${role}".`, details: { role, available: listRoleViews().map((x) => x.role) } },
      };
    }
    return { data: v };
  },
};

export const recommendCommandsTool: IToolDefinition = {
  name: 'recommend_commands',
  description:
    'Recommend SharkCraft commands for a free-form query or stderr blob. Deterministic — no AI. **For agent first-task grounding prefer `prepare_agent_task`**; this tool is the underlying ranker exposed for ad-hoc lookups.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      fromError: { type: 'string' },
      role: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const query = typeof input['query'] === 'string' ? (input['query'] as string) : '';
    const fromError = typeof input['fromError'] === 'string' ? (input['fromError'] as string) : undefined;
    const role = typeof input['role'] === 'string' ? (input['role'] as string) : undefined;
    const r = await recommendCommands(ctx.inspection, query, {
      ...(fromError ? { fromError } : {}),
      ...(role ? { role } : {}),
    });
    return { data: r };
  },
};

export const suggestDiagnosticTool: IToolDefinition = {
  name: 'suggest_diagnostic',
  description: 'Suggest the most likely diagnostic for a stderr blob.',
  inputSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  },
  async handler(input) {
    const s = typeof input['input'] === 'string' ? (input['input'] as string) : '';
    return { data: suggestDiagnostic(s) };
  },
};

export const getDashboardExportPreviewTool: IToolDefinition = {
  name: 'get_dashboard_export_preview',
  description: 'Preview what `shrk dashboard export` would write. Read-only — does NOT touch disk.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return {
      data: {
        sections: ['repository-map', 'architecture-map', 'intelligence-graph', 'role-views', 'packs', 'commands', 'safety', 'sessions', 'bundles', 'recent-reports', 'index.json'],
        nextCommand: 'shrk dashboard export --output .sharkcraft/dashboard-data',
        targetDir: '.sharkcraft/dashboard-data',
      },
    };
  },
};

export const getPackQualityReportTool: IToolDefinition = {
  name: 'get_pack_quality_report',
  description: 'Pack quality score for a specific pack name or path. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { pack: { type: 'string' } },
    required: ['pack'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const target = typeof input['pack'] === 'string' ? (input['pack'] as string) : '';
    const pack = ctx.inspection.packs.validPacks.find((p) => p.packageName === target || p.packageRoot === target);
    if (!pack) {
      return {
        isError: true,
        error: { code: 'pack-not-found', message: `Pack "${target}" not found.`, details: { target } },
      };
    }
    return { data: scorePack(ctx.inspection, pack) };
  },
};

export const getPackDocsPreviewTool: IToolDefinition = {
  name: 'get_pack_docs_preview',
  description: 'Preview README-style markdown for a pack at the given path. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = typeof input['path'] === 'string' ? (input['path'] as string) : '';
    return { data: generatePackDocs(p) };
  },
};

export const listReposetTool: IToolDefinition = {
  name: 'list_reposet',
  description: 'List repos in the local reposet config (read-only).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const cfg = loadReposetConfig(ctx.inspection.projectRoot);
    return { data: cfg ?? { schema: 'sharkcraft.reposet/v1', repos: [] } };
  },
};

export const getReposetMapTool: IToolDefinition = {
  name: 'get_reposet_map',
  description: 'Aggregate map across the reposet (read-only).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const cfg = loadReposetConfig(ctx.inspection.projectRoot);
    if (!cfg) return { data: { schema: 'sharkcraft.reposet-map/v1', repos: [], note: 'no reposet config' } };
    const map = await buildReposetMap(cfg);
    return { data: map };
  },
};

export const listReleaseTrainsTool: IToolDefinition = {
  name: 'list_release_trains',
  description: 'List local release trains.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: listReleaseTrains(ctx.inspection.projectRoot) };
  },
};

export const getReleaseTrainTool: IToolDefinition = {
  name: 'get_release_train',
  description: 'Get a release train by id, with readiness.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = typeof input['id'] === 'string' ? (input['id'] as string) : '';
    const train = getReleaseTrain(ctx.inspection.projectRoot, id);
    if (!train) {
      return { isError: true, error: { code: 'release-train-not-found', message: `Train ${id} not found.`, details: { id } } };
    }
    const readiness = computeReleaseTrainReadiness(ctx.inspection.projectRoot, train);
    return { data: { train, readiness } };
  },
};

export const getUpgradeAdviceTool: IToolDefinition = {
  name: 'get_upgrade_advice',
  description: 'Read-only SharkCraft upgrade advice (schema-version detection).',
  inputSchema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const from = typeof input['from'] === 'string' ? (input['from'] as string) : undefined;
    const to = typeof input['to'] === 'string' ? (input['to'] as string) : undefined;
    return { data: buildUpgradeAdvice(ctx.inspection, { ...(from ? { from } : {}), ...(to ? { to } : {}) }) };
  },
};

export const getSafetyAuditDeepTool: IToolDefinition = {
  name: 'get_safety_audit_deep',
  description: 'Deep safety audit: report-site external JS, demo destructive lines, CI permissions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: await buildSafetyAuditDeep(ctx.inspection) };
  },
};

export const getPackageApiReportTool: IToolDefinition = {
  name: 'get_package_api_report',
  description: 'Public API report for SharkCraft packages.',
  inputSchema: {
    type: 'object',
    properties: { package: { type: 'string' } },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const pkg = typeof input['package'] === 'string' ? (input['package'] as string) : undefined;
    return { data: buildApiReport(ctx.inspection, pkg ? { packageFilter: pkg } : {}) };
  },
};
