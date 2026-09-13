/**
 * Read-only MCP tool: get_changed_boundary_report.
 *
 * Returns the boundary engine output filtered to changes introduced by a
 * specific set of files (working tree, staged, since <ref>, or explicit list).
 * The tool never writes — applying a fix is CLI-only.
 *
 * Round 11: the TypeScript half goes through THE boundary orchestrator — so it
 * resolves tsconfig aliases (it used not to), scans once (it used to scan
 * twice), and ESCALATES a rule whose definition the changeset touched: the
 * violations a rule edit creates in untouched files are reported, never filed
 * as "legacy". It carries the same verdict as `shrk check boundaries
 * --changed-only`.
 */
import { summarizeImports } from '@shrkcrft/boundaries';
import {
  buildPolyglotBoundaryReport,
  filterViolationsToChangedScope,
  runBoundaryCheck,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getChangedBoundaryReportTool: IToolDefinition = {
  name: 'get_changed_boundary_report',
  description:
    'Run the boundary engine (TS + polyglot) and return only the violations introduced or touched by the supplied scope (working tree, staged, since <ref>, or explicit files). A changeset that edits a rule definition escalates that rule to the whole tree. Carries the same verdict as `shrk check boundaries --changed-only`. Read-only.',
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
    // Always THE orchestrator — including over zero rules. It settles an empty
    // rule set to not-verified (2) with the configuration diagnostic, exactly
    // what `shrk check boundaries --changed-only` and MCP `check_boundaries`
    // return; a `hasRules` guard here used to answer `typescript: null` — no
    // verdict at all — where both siblings said 2.
    const ts = runBoundaryCheck(ctx.inspection, { changedScope: scopeOpts });
    const polyglotReport = polyglot ? buildPolyglotBoundaryReport({ projectRoot }) : null;
    const polyglotFiltered = polyglotReport
      ? filterViolationsToChangedScope(polyglotReport.violations, scopeOpts)
      : null;
    return {
      text: nextHint('shrk check boundaries --changed-only' + (polyglot ? ' --polyglot' : '')),
      data: {
        schema: 'sharkcraft.changed-boundary-report/v1',
        mode: ts?.changed?.mode ?? polyglotFiltered?.mode ?? null,
        changedFiles: ts?.changed?.changedFiles ?? polyglotFiltered?.changedFiles ?? [],
        typescript: ts
          ? {
              total: ts.evaluation.violations.length,
              included: ts.violations,
              ignoredLegacyCount: ts.changed?.ignoredLegacyCount ?? 0,
              ignoredLegacyByRule: ts.changed?.ignoredLegacyByRule ?? {},
              governedFiles: ts.changed?.governedFiles ?? [],
              escalation: {
                ruleIds: ts.changed?.escalatedRuleIds ?? [],
                reasons: ts.changed?.escalation.reasons ?? [],
              },
              staleExceptions: ts.staleExceptions,
              loadIssues: ts.loadIssues,
              verdict: ts.verdict,
              exitCode: ts.exitCode,
              shortfalls: ts.shortfalls,
              runCoverage: ts.runCoverage,
              // Round 13 review: the settled unit states and acceptances, in the
              // shapes MCP `check_boundaries` returns — the changed-scope CLI run
              // prints them (the acceptance under its ✓, a went-live marker
              // withholding it); this tool dropped them all.
              deadUnits: ts.deadUnits,
              intendedEmpty: ts.intendedEmpty,
              wentLive: ts.wentLive,
              failingUnits: ts.failingUnits,
              accepted: ts.accepted,
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
        graphSummary: ts ? summarizeImports(ts.scan) : null,
      },
    };
  },
};
