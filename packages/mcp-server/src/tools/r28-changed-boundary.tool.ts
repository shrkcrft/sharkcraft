/**
 * Read-only MCP tool: get_changed_boundary_report.
 *
 * Returns the boundary engine output filtered to changes introduced by a
 * specific set of files (working tree, staged, since <ref>, or explicit list).
 * The tool never writes — applying a fix is CLI-only.
 */
import { evaluateBoundaries, scanImports, summarizeImports } from '@shrkcrft/boundaries';
import {
  buildPolyglotBoundaryReport,
  filterViolationsToChangedScope,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getChangedBoundaryReportTool: IToolDefinition = {
  name: 'get_changed_boundary_report',
  description:
    'Run the boundary engine (TS + polyglot) and return only the violations introduced or touched by the supplied scope (working tree, staged, since <ref>, or explicit files). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      since: { type: 'string', description: 'Compare against the given ref (HEAD, origin/main, SHA).' },
      staged: { type: 'boolean' },
      files: { type: 'array', items: { type: 'string' } },
      polyglot: { type: 'boolean', description: 'Include polyglot engine output.' },
    },
  },
  async handler(input, ctx) {
    const since = typeof input.since === 'string' ? input.since : undefined;
    const staged = input.staged === true;
    const files = Array.isArray(input.files) ? (input.files as string[]) : [];
    const polyglot = input.polyglot === true;
    const projectRoot = ctx.cwd;
    const scopeOpts = {
      projectRoot,
      ...(files.length > 0 ? { files } : {}),
      ...(staged ? { staged: true } : {}),
      ...(since ? { since } : {}),
      ...(!since && !staged && files.length === 0 ? { includeWorktree: true } : {}),
    };
    const rules = ctx.inspection.boundaryRegistry.list();
    const tsEval = rules.length === 0
      ? null
      : evaluateBoundaries(scanImports({ projectRoot }), rules, {});
    const tsFiltered = tsEval
      ? filterViolationsToChangedScope(tsEval.violations, scopeOpts)
      : null;
    const polyglotReport = polyglot ? buildPolyglotBoundaryReport({ projectRoot }) : null;
    const polyglotFiltered = polyglotReport
      ? filterViolationsToChangedScope(polyglotReport.violations, scopeOpts)
      : null;
    return {
      text: nextHint('shrk check boundaries --changed-only' + (polyglot ? ' --polyglot' : '')),
      data: {
        schema: 'sharkcraft.changed-boundary-report/v1',
        mode: tsFiltered?.mode ?? polyglotFiltered?.mode ?? null,
        changedFiles: tsFiltered?.changedFiles ?? polyglotFiltered?.changedFiles ?? [],
        typescript: tsFiltered
          ? {
              total: tsEval?.violations.length ?? 0,
              included: tsFiltered.includedViolations,
              ignoredLegacyCount: tsFiltered.ignoredLegacyCount,
              ignoredLegacyByRule: tsFiltered.ignoredLegacyByRule,
            }
          : null,
        polyglot: polyglotFiltered && polyglotReport
          ? {
              total: polyglotReport.violations.length,
              included: polyglotFiltered.includedViolations,
              ignoredLegacyCount: polyglotFiltered.ignoredLegacyCount,
              ignoredLegacyByRule: polyglotFiltered.ignoredLegacyByRule,
              languages: polyglotReport.languages,
            }
          : null,
        graphSummary: rules.length > 0 ? summarizeImports(scanImports({ projectRoot })) : null,
      },
    };
  },
};
