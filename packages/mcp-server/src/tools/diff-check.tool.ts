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
 *
 * Round 11: the boundary half goes through THE boundary orchestrator (aliases
 * resolved, rule edits escalated), and an empty diff — or one nothing examined
 * — is `not-verified` with `ran: false` and a reason, never "Diff passes".
 */

import { coverageShortfall } from '@shrkcrft/core';
import {
  boundaryRulesEvaluated,
  buildImportHygieneReport,
  describeBoundaryConfiguration,
  importHygieneCoverage,
  importHygieneSubjects,
  resolveChangedFiles,
  runBoundaryCheck,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
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
    'Self-check the current git diff against this project\'s boundary + import-hygiene rules. Single-call composite of the boundary-check (rule edits escalate to the whole tree) and import-hygiene engines, scoped to the changed files, with one verdict (ok | warnings | errors | not-verified) and one nextAction line. An empty diff, or one nothing examined, is not-verified. Use after editing code so you can validate before declaring done. Read-only.',
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

    const inspection = ctx.inspection;
    const loadIssues = inspection.boundaryLoadIssues ?? [];
    let boundaryBlock: {
      ran: boolean;
      reason?: string;
      rulesEvaluated: number;
      counts: { error: number; warning: number; info: number };
      violations: ReadonlyArray<Record<string, unknown>>;
      escalatedRuleIds?: readonly string[];
      loadIssues?: ReadonlyArray<Record<string, unknown>>;
      staleExceptions?: ReadonlyArray<Record<string, unknown>>;
      exitCode?: number;
      shortfalls?: readonly string[];
    } = {
      ran: false,
      rulesEvaluated: 0,
      counts: { error: 0, warning: 0, info: 0 },
      violations: [],
    };
    if (inspection.boundaryRegistry.size() === 0 && loadIssues.length === 0) {
      boundaryBlock.reason = describeBoundaryConfiguration(inspection).diagnostics[0] ?? 'no boundary rules configured';
    } else if (changedFiles.length === 0 && loadIssues.length === 0) {
      boundaryBlock.reason = 'no changed files in the diff scope';
    } else {
      const r = runBoundaryCheck(inspection, { changed: { mode: changed.mode, files: changedFiles } });
      if (r.selectedRuleIds.length === 0 && r.loadIssues.length === 0) {
        boundaryBlock.reason = 'no changed source file is governed by a boundary rule';
      } else {
        boundaryBlock = {
          ran: true,
          rulesEvaluated: boundaryRulesEvaluated(r),
          counts: r.counts,
          violations: r.violations as unknown as ReadonlyArray<Record<string, unknown>>,
          ...(r.changed && r.changed.escalatedRuleIds.length > 0 ? { escalatedRuleIds: r.changed.escalatedRuleIds } : {}),
          ...(r.loadIssues.length > 0 ? { loadIssues: r.loadIssues as unknown as ReadonlyArray<Record<string, unknown>> } : {}),
          ...(r.staleExceptions.length > 0
            ? { staleExceptions: r.staleExceptions as unknown as ReadonlyArray<Record<string, unknown>> }
            : {}),
          exitCode: r.exitCode,
          shortfalls: r.shortfalls,
        };
      }
    }

    let importsBlock = {
      ran: false,
      reason: undefined as string | undefined,
      verdict: 'skipped' as 'ok' | 'warnings' | 'errors' | 'skipped',
      counts: {} as Readonly<Record<string, number>>,
      findings: [] as ReadonlyArray<Record<string, unknown>>,
      unread: [] as readonly string[],
      shortfall: undefined as string | undefined,
    };
    const hygieneFiles = changedFiles.length > 0 ? importHygieneSubjects(cwd, changedFiles) : [];
    if (changedFiles.length === 0) {
      importsBlock.reason = 'no changed files in the diff scope';
    } else if (hygieneFiles.length === 0) {
      importsBlock.reason = 'no changed .ts/.tsx source for import hygiene to read';
    } else {
      const report = buildImportHygieneReport(cwd, { files: changedFiles });
      // THE hygiene coverage fold (the CLI's `diff-check` and finish read it
      // too): an unreadable changed source was never checked.
      const shortfall = coverageShortfall(importHygieneCoverage(report, 'changed source files'));
      importsBlock = {
        ran: true,
        reason: undefined,
        verdict: report.verdict,
        counts: report.counts ?? {},
        findings: report.findings as unknown as ReadonlyArray<Record<string, unknown>>,
        unread: report.unread ?? [],
        shortfall: shortfall !== undefined ? `imports: ${shortfall}` : undefined,
      };
    }

    // Derive verdict — the CLI's logic, mirrored here to keep the MCP tool
    // self-contained (no CLI import — preserves the package dependency
    // direction). The boundary half's own verdict comes from the orchestrator.
    const bErr = boundaryBlock.counts.error;
    const bWarn = boundaryBlock.counts.warning;
    const bFailed = boundaryBlock.exitCode === 1;
    const bPartial = boundaryBlock.exitCode === 2;
    const iErr = importsBlock.verdict === 'errors' ? (importsBlock.counts.error ?? importsBlock.findings.length) : 0;
    const iWarn = importsBlock.verdict === 'warnings' ? (importsBlock.counts.warning ?? importsBlock.findings.length) : 0;
    let verdict: 'ok' | 'warnings' | 'errors' | 'not-verified';
    let exitCode: number;
    let summary: string;
    let nextAction: string;
    if (bFailed || iErr > 0) {
      verdict = 'errors';
      exitCode = 1;
      const parts: string[] = [];
      if (bErr > 0) parts.push(`${bErr} boundary violation${bErr === 1 ? '' : 's'}`);
      if (bFailed && bErr === 0) parts.push('an errored boundary rule / stale exception');
      if (iErr > 0) parts.push(`${iErr} import-hygiene error${iErr === 1 ? '' : 's'}`);
      summary = `Diff fails the gate: ${parts.join(', ')}.`;
      nextAction =
        'Fix every error in `boundaries.violations` and `imports.findings` (each entry\'s `suggestedFix` shows the fix), then re-run.';
    } else if (!boundaryBlock.ran && !importsBlock.ran) {
      verdict = 'not-verified';
      exitCode = 2;
      summary =
        changedFiles.length === 0
          ? 'No files changed in the current diff scope — nothing was checked (this is not a pass).'
          : 'Nothing in the diff is governed by a boundary rule or read by import hygiene — nothing was checked (this is not a pass).';
      nextAction =
        'Nothing was verified. If you expected changes, verify the `staged` / `since` argument or save edits first.';
    } else if (bPartial || importsBlock.shortfall !== undefined) {
      verdict = 'not-verified';
      exitCode = 2;
      const gaps = [...(bPartial ? (boundaryBlock.shortfalls ?? []) : []), ...(importsBlock.shortfall ? [importsBlock.shortfall] : [])];
      summary = `Not verified: ${gaps.slice(0, 3).join('; ')} — this is NOT a pass.`;
      nextAction = 'Part of the scope was never examined — fix the rule scope named above, then re-run.';
    } else if (bWarn > 0 || iWarn > 0) {
      verdict = 'warnings';
      exitCode = 0;
      const parts: string[] = [];
      if (bWarn > 0) parts.push(`${bWarn} boundary warning${bWarn === 1 ? '' : 's'}`);
      if (iWarn > 0) parts.push(`${iWarn} import-hygiene warning${iWarn === 1 ? '' : 's'}`);
      summary = `Diff passes the gate with ${parts.join(', ')}.`;
      nextAction = 'Safe to declare done. Review warnings if the diff touches a sensitive area.';
    } else {
      verdict = 'ok';
      exitCode = 0;
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
        exitCode,
        summary,
        nextAction,
      },
    };
  },
};
