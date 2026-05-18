/**
 * Polyglot boundary / adoption MCP tools. Read-only.
 *
 * - get_polyglot_boundary_report
 * - preview_ingest_adoption_plan (returns the plan only — apply is CLI-only)
 * - get_language_run_plan (returns a dry-run plan — execute is CLI-only)
 * - get_language_cache_status
 *
 * Every tool returns data + a next-command hint. No tool ever writes.
 */
import { readFileSync } from 'node:fs';
import {
  buildIngestAdoptionPlan,
  buildIngestApplyPlan,
  buildLanguageRunPlan,
  buildPolyglotBoundaryReport,
  buildRepositoryKnowledgeModel,
  detectLanguageProfiles,
  getLanguageCacheStatus,
  IngestAdoptionStatus,
  LanguageId,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getPolyglotBoundaryReportTool: IToolDefinition = {
  name: 'get_polyglot_boundary_report',
  description: 'Polyglot boundary enforcement report (Java/C#/Python/Go/Rust). Returns rules, edges, violations, suggestedFixes. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      language: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  handler(input, ctx) {
    const lang = typeof input.language === 'string' ? input.language : undefined;
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    const report = buildPolyglotBoundaryReport({
      projectRoot: ctx.cwd,
      ...(lang && lang !== 'all' ? { languages: [lang as LanguageId] } : {}),
      ...(limit ? { limit } : {}),
    });
    return {
      text: nextHint(`shrk check boundaries --polyglot${lang && lang !== 'all' ? ' --language ' + lang : ''}`),
      data: report,
    };
  },
};

export const previewIngestAdoptionPlanTool: IToolDefinition = {
  name: 'preview_ingest_adoption_plan',
  description: 'Preview an ingest adoption apply plan. Read-only — returns the plan body only. To actually apply, run the CLI with the same flags.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      include: { type: 'array', items: { type: 'string' } },
      includeManualReview: { type: 'boolean' },
    },
  },
  async handler(input, ctx) {
    const model = await buildRepositoryKnowledgeModel({ inspection: ctx.inspection });
    const adoption = buildIngestAdoptionPlan({ model });
    const includeArr = Array.isArray(input.include) ? input.include.map(String) : ['safe-append'];
    const include = includeArr
      .map((s) => s as IngestAdoptionStatus)
      .filter((s) => Object.values(IngestAdoptionStatus).includes(s));
    const result = buildIngestApplyPlan({
      plan: adoption,
      include: include.length > 0 ? include : [IngestAdoptionStatus.SafeAppend],
      includeManualReview: input.includeManualReview === true,
    });
    return {
      text: nextHint('shrk ingest adopt plan --include safe-append --output sharkcraft/ingestion/adoption/ingest-adopt-plan.json'),
      data: {
        plan: result.plan,
        skipped: result.skipped,
        fileBodyPreviews: Object.keys(result.files).slice(0, 12).reduce<Record<string, string>>((acc, k) => {
          const body = result.files[k] ?? '';
          acc[k] = body.slice(0, 600);
          return acc;
        }, {}),
      },
    };
  },
};

export const getLanguageRunPlanTool: IToolDefinition = {
  name: 'get_language_run_plan',
  description: 'Plan a per-language test/build/lint command set. Returns the dry-run plan; execution is CLI-only via `shrk languages run --execute`.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      category: { type: 'string' },
      language: { type: 'string' },
      commandId: { type: 'string' },
      allTests: { type: 'boolean' },
      allowInstall: { type: 'boolean' },
    },
  },
  handler(input, ctx) {
    const plan = buildLanguageRunPlan({
      projectRoot: ctx.cwd,
      category: typeof input.category === 'string' ? (input.category as never) : 'test',
      ...(typeof input.language === 'string' ? { language: input.language as LanguageId } : {}),
      ...(typeof input.commandId === 'string' ? { commandId: input.commandId } : {}),
      allTests: input.allTests === true,
      allowInstall: input.allowInstall === true,
      execute: false,
    });
    return {
      text: nextHint('shrk languages run --execute' + (input.allowInstall === true ? ' --allow-install' : '')),
      data: plan,
    };
  },
};

export const getLanguageCacheStatusTool: IToolDefinition = {
  name: 'get_language_cache_status',
  description: 'Status of the local language profile cache (`.sharkcraft/languages/cache.json`). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    // SharkCraft version is best-effort — read package.json if present.
    let version = '0.1.0';
    try {
      const pkg = JSON.parse(readFileSync(`${ctx.cwd}/package.json`, 'utf8'));
      if (typeof pkg.version === 'string') version = pkg.version;
    } catch {
      // ignore
    }
    const status = getLanguageCacheStatus(ctx.cwd, version);
    return {
      text: nextHint(status.fresh ? 'shrk languages detect --cache' : 'shrk languages detect --cache --refresh-cache'),
      data: status,
    };
  },
};

// Reuse for completeness — detect on-demand without cache.
export const getLanguageProfilesLiveTool: IToolDefinition = {
  name: 'get_language_profiles_live',
  description: 'Live language detection (TS/JS/Java/C#/Python/Go/Rust). Pure read-only walk; no cache.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    const report = detectLanguageProfiles(ctx.cwd);
    return { text: nextHint('shrk languages detect --cache'), data: report };
  },
};
