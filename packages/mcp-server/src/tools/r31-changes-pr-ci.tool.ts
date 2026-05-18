/**
 * Read-only MCP tools for changes summary, PR summary, CI integrity.
 */
import {
  buildChangesSummary,
  buildCiIntegrityReport,
  buildPrSummary,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

const DIFF_INPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    since: { type: 'string' as const },
    staged: { type: 'boolean' as const },
    files: { type: 'array' as const, items: { type: 'string' as const } },
  },
};

export const getChangesSummaryTool: IToolDefinition = {
  name: 'get_changes_summary',
  description:
    'Grouped changes summary over --since / --staged / --files. Returns area breakdown + risk verdict + suggested validation commands. Read-only.',
  inputSchema: DIFF_INPUT_SCHEMA,
  async handler(input, ctx) {
    const opts: { since?: string; staged?: boolean; files?: readonly string[] } = {};
    if (typeof input.since === 'string') opts.since = input.since;
    if (input.staged === true) opts.staged = true;
    if (Array.isArray(input.files)) opts.files = input.files as readonly string[];
    const report = await buildChangesSummary(ctx.inspection, opts);
    return {
      text: 'Next: `shrk changes summary --since <ref>` (CLI is the only write path).',
      data: report,
    };
  },
};

export const getPrSummaryPreviewTool: IToolDefinition = {
  name: 'get_pr_summary_preview',
  description:
    'Render a PR description preview from the working-tree changes + reports under .sharkcraft/reports. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      since: { type: 'string' },
      staged: { type: 'boolean' },
      files: { type: 'array', items: { type: 'string' } },
      maxItems: { type: 'number' },
      reportsDir: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const opts: {
      since?: string;
      staged?: boolean;
      files?: readonly string[];
      maxItems?: number;
      reportsDir?: string;
    } = {};
    if (typeof input.since === 'string') opts.since = input.since;
    if (input.staged === true) opts.staged = true;
    if (Array.isArray(input.files)) opts.files = input.files as readonly string[];
    if (typeof input.maxItems === 'number') opts.maxItems = input.maxItems;
    if (typeof input.reportsDir === 'string') opts.reportsDir = input.reportsDir;
    const report = await buildPrSummary(ctx.inspection, opts);
    return {
      text: 'Next: `shrk pr summary --since <ref>` (CLI writes only when --output is passed).',
      data: report,
    };
  },
};

export const getCiIntegrityReportTool: IToolDefinition = {
  name: 'get_ci_integrity_report',
  description:
    'Aggregate the JSON reports under .sharkcraft/reports into a single CI integrity verdict. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { reportsDir: { type: 'string' } },
  },
  async handler(input, ctx) {
    const reportsDir = typeof input.reportsDir === 'string' ? input.reportsDir : undefined;
    const report = buildCiIntegrityReport(
      ctx.inspection.projectRoot,
      reportsDir ? { reportsDir } : {},
    );
    return {
      text: 'Next: `shrk ci report --format markdown` (CLI is the only write path).',
      data: report,
    };
  },
};
