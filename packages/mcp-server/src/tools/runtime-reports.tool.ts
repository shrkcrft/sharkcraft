/**
 * Read-only MCP tools that mirror `shrk report ...`. Each returns the rendered
 * body (or structured JSON) without writing to disk and without running shell
 * commands. SharkCraft's MCP contract: data only, plus a `nextCommand` hint.
 *
 * NOTE: the four HTML-report tools (`get_session_html_report`,
 * `get_quality_html_report`, `get_safety_html_report`, `get_review_html_report`)
 * were intentionally retired — the local dashboard already renders that HTML.
 * They are deleted here (not merely de-registered) so the dead exports cannot
 * silently drift back into `ALL_TOOLS`. The guard is
 * `__tests__/tool-registry-drift.test.ts`.
 */
import {
  buildAdoptionReport,
  buildCoverageReport,
  buildDriftReport,
  buildOnboardingAdoptionPlan,
  buildOnboardingPlan,
  readAdoptionState,
  renderAdoptionReportHtml,
  renderAdoptionReportMarkdown,
  renderAdoptionReportText,
} from '@shrkcrft/inspector';
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
