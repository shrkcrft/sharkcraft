/**
 * Read-only MCP tool: get_diff_check_report.
 *
 * The MCP-side mirror of `shrk diff-check`. Same envelope, same
 * verdict logic — the agent gets a single structured answer to "did
 * my edits pass this project's boundary + import-hygiene gates?".
 *
 * Still read-only: this tool DOES NOT fix anything, even when it
 * could trivially suggest the fix. The agent reads the envelope, then
 * the human (or the agent, via a separate write-path tool) runs the
 * fix on the CLI. Keeps the safety contract intact.
 */

import {
  buildImportHygieneReport,
  filterViolationsToChangedScope,
  resolveChangedFiles,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import {
  evaluateBoundaries,
  loadTsconfigPaths,
  scanImports,
} from '@shrkcrft/boundaries';
import type { IToolDefinition } from '../server/tool-definition.ts';

const SCHEMA = 'sharkcraft.diff-check/v1';

function resolveScopeFromInput(
  input: Record<string, unknown>,
  cwd: string,
): { mode: 'worktree' | 'staged' | 'since' | 'files'; options: IChangedScopeOptions } {
  const staged = input.staged === true;
  const since = typeof input.since === 'string' ? input.since : undefined;
  const files = Array.isArray(input.files)
    ? (input.files as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];
  if (files.length > 0) {
    return { mode: 'files', options: { projectRoot: cwd, files } };
  }
  if (staged) {
    return { mode: 'staged', options: { projectRoot: cwd, staged: true } };
  }
  if (since) {
    return { mode: 'since', options: { projectRoot: cwd, since } };
  }
  return { mode: 'worktree', options: { projectRoot: cwd, includeWorktree: true } };
}

export const getDiffCheckReportTool: IToolDefinition = {
  name: 'get_diff_check_report',
  description:
    'Self-check the current git diff against this project\'s boundary + import-hygiene rules. Single-call composite of the boundary-check and import-hygiene engines, scoped to the changed files, with one verdict (ok | warnings | errors) and one nextAction line. Use after editing code so you can validate before declaring done. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      staged: { type: 'boolean', description: 'Scope to staged changes only.' },
      since: { type: 'string', description: 'Compare against ref (HEAD, origin/main, SHA).' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit file list (overrides --staged / --since).',
      },
    },
  },
  async handler(input, ctx) {
    const cwd = ctx.cwd;
    const { mode, options: scopeOptions } = resolveScopeFromInput(input, cwd);
    const changed = resolveChangedFiles(scopeOptions);
    const changedFiles = changed.files;

    const rules = ctx.inspection.boundaryRegistry.list();
    let boundaryBlock = {
      ran: false,
      rulesEvaluated: 0,
      counts: { error: 0, warning: 0, info: 0 },
      violations: [] as ReadonlyArray<Record<string, unknown>>,
    };
    if (rules.length > 0 && changedFiles.length > 0) {
      const scan = scanImports({ projectRoot: cwd });
      const tsconfigPaths = loadTsconfigPaths(cwd);
      const evalResult = evaluateBoundaries(scan, rules, {
        ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
      });
      const filtered = filterViolationsToChangedScope(evalResult.violations, scopeOptions);
      boundaryBlock = {
        ran: true,
        rulesEvaluated: evalResult.rulesEvaluated,
        counts: {
          error: filtered.includedViolations.filter((v) => v.severity === 'error').length,
          warning: filtered.includedViolations.filter((v) => v.severity === 'warning').length,
          info: filtered.includedViolations.filter((v) => v.severity === 'info').length,
        },
        violations: filtered.includedViolations as unknown as ReadonlyArray<Record<string, unknown>>,
      };
    } else if (rules.length > 0) {
      boundaryBlock = { ...boundaryBlock, ran: true, rulesEvaluated: rules.length };
    }

    let importsBlock = {
      ran: false,
      verdict: 'skipped' as 'ok' | 'warnings' | 'errors' | 'skipped',
      counts: {} as Readonly<Record<string, number>>,
      findings: [] as ReadonlyArray<Record<string, unknown>>,
    };
    if (changedFiles.length > 0) {
      const report = buildImportHygieneReport(cwd, { files: changedFiles });
      importsBlock = {
        ran: true,
        verdict: report.verdict,
        counts: report.counts ?? {},
        findings: report.findings as unknown as ReadonlyArray<Record<string, unknown>>,
      };
    }

    // Derive verdict — same logic as the CLI command, duplicated
    // intentionally to keep the MCP tool self-contained (no CLI
    // import — preserves the package dependency direction).
    const bErr = boundaryBlock.counts.error;
    const bWarn = boundaryBlock.counts.warning;
    const iErr = importsBlock.verdict === 'errors' ? (importsBlock.counts.error ?? importsBlock.findings.length) : 0;
    const iWarn = importsBlock.verdict === 'warnings' ? (importsBlock.counts.warning ?? importsBlock.findings.length) : 0;
    let verdict: 'ok' | 'warnings' | 'errors';
    let summary: string;
    let nextAction: string;
    if (changedFiles.length === 0) {
      verdict = 'ok';
      summary = 'No files changed in the current diff scope.';
      nextAction =
        'Nothing to check. If you expected changes, verify the `staged` / `since` argument or save edits first.';
    } else if (bErr > 0 || iErr > 0) {
      verdict = 'errors';
      const parts: string[] = [];
      if (bErr > 0) parts.push(`${bErr} boundary violation${bErr === 1 ? '' : 's'}`);
      if (iErr > 0) parts.push(`${iErr} import-hygiene error${iErr === 1 ? '' : 's'}`);
      summary = `Diff fails the gate: ${parts.join(', ')}.`;
      nextAction =
        'Fix every error in `boundaries.violations` and `imports.findings` (each entry\'s `suggestedFix` shows the fix), then re-run.';
    } else if (bWarn > 0 || iWarn > 0) {
      verdict = 'warnings';
      const parts: string[] = [];
      if (bWarn > 0) parts.push(`${bWarn} boundary warning${bWarn === 1 ? '' : 's'}`);
      if (iWarn > 0) parts.push(`${iWarn} import-hygiene warning${iWarn === 1 ? '' : 's'}`);
      summary = `Diff passes the gate with ${parts.join(', ')}.`;
      nextAction = 'Safe to declare done. Review warnings if the diff touches a sensitive area.';
    } else {
      verdict = 'ok';
      summary = `Diff passes the gate (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}, 0 violations).`;
      nextAction = 'Safe to declare done.';
    }

    return {
      text: `verdict=${verdict}. ${summary} ${nextAction}`,
      data: {
        schema: SCHEMA,
        generatedAt: new Date().toISOString(),
        scope: {
          mode,
          files: changedFiles,
          fileCount: changedFiles.length,
        },
        boundaries: boundaryBlock,
        imports: importsBlock,
        verdict,
        summary,
        nextAction,
      },
    };
  },
};
