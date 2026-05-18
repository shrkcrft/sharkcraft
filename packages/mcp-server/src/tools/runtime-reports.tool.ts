/**
 * Read-only MCP tools that mirror `shrk report ...`. Each returns the rendered
 * body (or structured JSON) without writing to disk and without running shell
 * commands. SharkCraft's MCP contract: data only, plus a `nextCommand` hint.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildAdoptionReport,
  buildCoverageReport,
  buildDriftReport,
  buildOnboardingAdoptionPlan,
  buildOnboardingPlan,
  buildQualityReport,
  buildSafetyAudit,
  readAdoptionState,
  renderAdoptionReportHtml,
  renderAdoptionReportMarkdown,
  renderAdoptionReportText,
  renderDevSessionHtml,
  renderDevSessionFinalReport,
  renderReviewComment,
  renderReviewHtml,
  renderQualityHtml,
  renderSafetyHtml,
  scanDevSession,
  type IReviewPacket,
} from '@shrkcrft/inspector';
// DX#4 — derive audit view from ALL_TOOLS at runtime.
import { ALL_TOOLS } from './all-tools.ts';
import type { IToolDefinition } from '../server/tool-definition.ts';

type ReportFormat = 'text' | 'markdown' | 'html' | 'json';

function pickFormat(input: Record<string, unknown>, fallback: ReportFormat = 'json'): ReportFormat {
  const f = String(input.format ?? fallback).toLowerCase();
  if (f === 'text' || f === 'markdown' || f === 'html' || f === 'json') return f;
  return fallback;
}

const READ_ONLY_NOTE = 'MCP cannot write — adoption / session / quality / safety / review outputs are returned as data only. Run the corresponding `shrk report ...` to persist.';

export const getAdoptionReportTool: IToolDefinition = {
  name: 'get_adoption_report',
  description:
    'Render the onboarding adoption report (text / markdown / html / json). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', description: 'text|markdown|html|json (default: json)' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const plan = buildOnboardingPlan(ctx.inspection, {});
    const adoption = buildOnboardingAdoptionPlan({ inspection: ctx.inspection, plan });
    const state = readAdoptionState(ctx.cwd);
    const report = buildAdoptionReport({ projectRoot: ctx.cwd, plan: adoption, state });
    const format = pickFormat(input);
    if (format === 'html') return { text: renderAdoptionReportHtml(report), data: { format, schema: 'sharkcraft.adoption-report/v1', nextCommand: 'shrk report adoption --format html --output adoption.html', note: READ_ONLY_NOTE } };
    if (format === 'markdown') return { text: renderAdoptionReportMarkdown(report), data: { format, nextCommand: 'shrk report adoption --format markdown' } };
    if (format === 'text') return { text: renderAdoptionReportText(report), data: { format } };
    return { data: { format: 'json', report, nextCommand: 'shrk report adoption --format json', note: READ_ONLY_NOTE } };
  },
};

export const getSessionHtmlReportTool: IToolDefinition = {
  name: 'get_session_html_report',
  description:
    'Render an HTML / markdown / json report for a dev session. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      format: { type: 'string', description: 'html|markdown|json (default: html)' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const id = String(input.id ?? '');
    const load = scanDevSession(ctx.cwd, id);
    if (!load || !load.state) return { isError: true, data: { error: `no session "${id}"` } };
    const format = pickFormat(input, 'html');
    if (format === 'json') return { data: { id, format: 'json', state: load.state, nextCommand: 'shrk report session ' + id + ' --format json', note: READ_ONLY_NOTE } };
    if (format === 'markdown') return { text: renderDevSessionFinalReport(load, {}), data: { format } };
    return { text: renderDevSessionHtml(load), data: { format, schema: 'sharkcraft.dev-session/v1', nextCommand: `shrk dev open ${id} --html` } };
  },
};

export const getQualityHtmlReportTool: IToolDefinition = {
  name: 'get_quality_html_report',
  description:
    'Render the quality report (html / markdown / json / text). Gates that would run shell commands are recorded as skipped. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { format: { type: 'string' } },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const report = await buildQualityReport({ inspection: ctx.inspection, config: {}, skipShell: true });
    const format = pickFormat(input, 'html');
    if (format === 'json') return { data: { format, report, nextCommand: 'shrk report quality --format json' } };
    if (format === 'markdown' || format === 'text') return { text: JSON.stringify(report, null, 2) };
    return { text: renderQualityHtml(report), data: { format, schema: 'sharkcraft.quality-report/v1', nextCommand: 'shrk report quality --format html --output quality.html', note: READ_ONLY_NOTE } };
  },
};

export const getSafetyHtmlReportTool: IToolDefinition = {
  name: 'get_safety_html_report',
  description: 'Render the safety audit (html / markdown / json / text). Read-only.',
  inputSchema: {
    type: 'object',
    properties: { format: { type: 'string' } },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const audit = buildSafetyAudit({
      inspection: ctx.inspection,
      catalog: [],
      mcpTools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, canWrite: false })),
      planSecretEnv: 'SHARKCRAFT_PLAN_SECRET',
      planSecretConfigured: typeof process.env.SHARKCRAFT_PLAN_SECRET === 'string' && process.env.SHARKCRAFT_PLAN_SECRET.length > 0,
    });
    const format = pickFormat(input, 'html');
    if (format === 'json') return { data: { format, audit, nextCommand: 'shrk report safety --format json' } };
    if (format === 'markdown' || format === 'text') return { text: JSON.stringify(audit, null, 2) };
    return { text: renderSafetyHtml(audit), data: { format, schema: 'sharkcraft.safety-audit/v1', nextCommand: 'shrk report safety --format html --output safety.html', note: READ_ONLY_NOTE } };
  },
};

export const getReviewHtmlReportTool: IToolDefinition = {
  name: 'get_review_html_report',
  description:
    'Render a review packet as HTML / markdown / json. Pass `packetPath` (relative to cwd) or `packet` (inline object).',
  inputSchema: {
    type: 'object',
    properties: {
      packetPath: { type: 'string' },
      packet: { type: 'object' },
      format: { type: 'string' },
      collapseLongSections: { type: 'boolean' },
      maxItems: { type: 'integer' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    let packet: IReviewPacket | null = null;
    if (typeof input.packetPath === 'string') {
      const abs = nodePath.isAbsolute(input.packetPath) ? input.packetPath : nodePath.resolve(ctx.cwd, input.packetPath);
      if (!existsSync(abs)) return { isError: true, data: { error: `packet not found: ${abs}` } };
      packet = JSON.parse(readFileSync(abs, 'utf8')) as IReviewPacket;
    } else if (input.packet && typeof input.packet === 'object') {
      packet = input.packet as IReviewPacket;
    } else {
      return { isError: true, data: { error: 'provide packetPath or packet' } };
    }
    const format = pickFormat(input, 'html');
    if (format === 'json') return { data: { format, packet, nextCommand: 'shrk report review <packet.json> --format json' } };
    if (format === 'markdown' || format === 'text') return { text: renderReviewComment(packet, {}), data: { format } };
    return {
      text: renderReviewHtml(packet, {
        ...(input.collapseLongSections ? { collapseLongSections: true } : {}),
        ...(typeof input.maxItems === 'number' ? { maxItems: input.maxItems } : {}),
      }),
      data: { format, schema: 'sharkcraft.review-packet/v1', nextCommand: 'shrk report review <packet.json> --format html' },
    };
  },
};

export const getCoverageReportRenderedTool: IToolDefinition = {
  name: 'get_coverage_report_rendered',
  description: 'Render the coverage report as JSON (default) or markdown. Read-only.',
  inputSchema: { type: 'object', properties: { format: { type: 'string' } }, additionalProperties: false },
  handler(input, ctx) {
    const r = buildCoverageReport(ctx.inspection);
    const format = pickFormat(input, 'json');
    if (format === 'markdown' || format === 'text') return { text: JSON.stringify(r, null, 2) };
    return { data: { format, report: r, nextCommand: 'shrk report coverage --format json' } };
  },
};

export const getDriftReportRenderedTool: IToolDefinition = {
  name: 'get_drift_report_rendered',
  description: 'Render the drift report as JSON (default) or markdown. Read-only.',
  inputSchema: { type: 'object', properties: { format: { type: 'string' } }, additionalProperties: false },
  handler(input, ctx) {
    const r = buildDriftReport(ctx.inspection);
    const format = pickFormat(input, 'json');
    if (format === 'markdown' || format === 'text') return { text: JSON.stringify(r, null, 2) };
    return { data: { format, report: r, nextCommand: 'shrk report drift --format json' } };
  },
};
