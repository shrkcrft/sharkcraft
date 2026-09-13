/**
 * `shrk diff-check` — agent self-validation after edits.
 *
 * The story this command tells:
 *   1. An AI agent (Claude Code, Cursor, etc.) makes some file changes.
 *   2. Before declaring "done", the agent runs `shrk diff-check`.
 *   3. The command scopes both the boundary check and the
 *      import-hygiene check to only the files the agent touched in the
 *      current git diff.
 *   4. The output is a single agent-friendly JSON envelope with a
 *      verdict (ok / warnings / errors / not-verified) and a one-line next
 *      action.
 *
 * Why a new command instead of "just run `shrk check boundaries
 * --changed-only` and `shrk check imports --changed-only`":
 *
 *   - One command instead of two — agents reliably run the *one* tool
 *     they're told to run; chained-command workflows get skipped.
 *   - One verdict — no need to OR two separate JSON outputs.
 *   - Stable, narrow schema — designed for agent consumption, not
 *     human terminals. Won't grow flags over time.
 *   - Concrete `nextAction` line — the agent knows exactly what to do
 *     next (declare done, fix N things, or re-run after a manual fix).
 *
 * Round 11: the boundary half goes through THE boundary orchestrator (a rule
 * edit escalates to the whole tree; a change no rule governs is NOT a pass),
 * and the verdict is settled by the shared gate envelope — an empty diff, or a
 * diff nothing examined, is `not-verified` (2), never "Diff passes the gate".
 */

import {
  boundaryRulesEvaluated,
  buildImportHygieneReport,
  describeBoundaryConfiguration,
  importHygieneCoverage,
  importHygieneSubjects,
  inspectSharkcraft,
  resolveChangedFiles,
  runBoundaryCheck,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import type { IVerdictCoverage } from '@shrkcrft/core';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, bullet, header, kv } from '../output/format-output.ts';
import { ExitCode } from '../exit-codes.ts';
import { buildGateEnvelope, type IGateEnvelope, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { ruleSetCoverage } from '../finish/run-finish.ts';

const SCHEMA = 'sharkcraft.diff-check/v1';

interface IDiffCheckEnvelope {
  schema: typeof SCHEMA;
  generatedAt: string;
  scope: {
    mode: 'worktree' | 'staged' | 'since' | 'files';
    files: readonly string[];
    fileCount: number;
  };
  boundaries: {
    ran: boolean;
    /** Why the boundary check evaluated nothing, when `ran` is false. */
    reason?: string;
    rulesEvaluated: number;
    counts: { error: number; warning: number; info: number };
    violations: ReadonlyArray<Record<string, unknown>>;
    escalation?: { ruleIds: readonly string[]; files: readonly string[] };
    loadIssues?: ReadonlyArray<Record<string, unknown>>;
    staleExceptions?: ReadonlyArray<Record<string, unknown>>;
    coverage?: IVerdictCoverage;
  };
  imports: {
    ran: boolean;
    reason?: string;
    verdict: 'ok' | 'warnings' | 'errors' | 'skipped';
    counts: Readonly<Record<string, number>>;
    findings: ReadonlyArray<Record<string, unknown>>;
  };
  verdict: 'ok' | 'warnings' | 'errors' | 'not-verified';
  summary: string;
  nextAction: string;
  exitCode: number;
  gate: IGateEnvelope;
}

function resolveScope(args: ParsedArgs, cwd: string): {
  mode: 'worktree' | 'staged' | 'since' | 'files';
  options: IChangedScopeOptions;
} {
  const staged = flagBool(args, 'staged');
  const since = flagString(args, 'since');
  const filesRaw = flagString(args, 'files');
  // Files come from `--files a,b` or as bare positional args
  // (`shrk diff-check a.ts b.ts`). Positionals were previously ignored, which
  // silently widened the scope back to the full worktree.
  const files = filesRaw
    ? filesRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : args.positional.filter((s) => s.length > 0);
  if (files.length > 0) {
    return { mode: 'files', options: { projectRoot: cwd, files } };
  }
  if (staged) {
    return { mode: 'staged', options: { projectRoot: cwd, staged: true } };
  }
  if (since) {
    return { mode: 'since', options: { projectRoot: cwd, since } };
  }
  // Default: worktree (== `--changed-only` from `shrk check boundaries`).
  return {
    mode: 'worktree',
    options: { projectRoot: cwd, includeWorktree: true },
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const diffCheckCommand: ICommandHandler = {
  name: 'diff-check',
  description:
    'Self-check the current git diff against this project\'s boundary + import-hygiene rules. Single-call composite of `shrk check boundaries --changed-only` (rule edits escalate to the whole tree) + `shrk check imports --changed-only`, with one verdict and one nextAction line. An empty diff, or one nothing examined, is not-verified (exit 2). Designed for AI agents to run after editing — pass --json for the structured envelope.',
  usage:
    'shrk [--cwd <dir>] diff-check [files... | --files a.ts,b.ts | --staged | --since <ref>] [--allow-empty] [--json]',
  booleanFlags: new Set(['json', 'staged', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const { mode, options: scopeOptions } = resolveScope(args, cwd);

    // 1. Resolve the changed file set once. Both engines re-use it.
    const changed = resolveChangedFiles(scopeOptions);
    const changedFiles = changed.files;
    const inspection = await inspectSharkcraft({ cwd });
    const rows: IGateRuleResult[] = [];

    // 2. Boundary engine — THE orchestrator, escalation included.
    let boundaryBlock: IDiffCheckEnvelope['boundaries'] = {
      ran: false,
      rulesEvaluated: 0,
      counts: { error: 0, warning: 0, info: 0 },
      violations: [],
    };
    const loadIssues = inspection.boundaryLoadIssues ?? [];
    if (inspection.boundaryRegistry.size() === 0 && loadIssues.length === 0) {
      boundaryBlock.reason =
        describeBoundaryConfiguration(inspection).diagnostics[0] ?? 'no boundary rules configured';
    } else if (changedFiles.length === 0 && loadIssues.length === 0) {
      boundaryBlock.reason = 'no changed files in the diff scope';
    } else {
      const r = runBoundaryCheck(inspection, { changed: { mode: changed.mode, files: changedFiles } });
      if (r.selectedRuleIds.length === 0 && r.loadIssues.length === 0) {
        boundaryBlock.reason = 'no changed source file is governed by a boundary rule';
      } else {
        const { coverage } = ruleSetCoverage(
          'boundary rules',
          r.rules.map((x) => ({ ruleId: x.ruleId, coverage: x.coverage })),
          'passed over part of their scope or checked nothing',
        );
        const escalated = r.changed?.escalatedRuleIds ?? [];
        boundaryBlock = {
          ran: true,
          rulesEvaluated: boundaryRulesEvaluated(r),
          counts: r.counts,
          violations: r.violations as unknown as ReadonlyArray<Record<string, unknown>>,
          ...(escalated.length > 0
            ? {
                escalation: {
                  ruleIds: escalated,
                  files: [...new Set(r.changed?.escalation.reasons.map((x) => x.file) ?? [])],
                },
              }
            : {}),
          ...(r.loadIssues.length > 0
            ? { loadIssues: r.loadIssues as unknown as ReadonlyArray<Record<string, unknown>> }
            : {}),
          ...(r.staleExceptions.length > 0
            ? { staleExceptions: r.staleExceptions as unknown as ReadonlyArray<Record<string, unknown>> }
            : {}),
          coverage,
        };
        rows.push({
          id: 'boundaries',
          type: 'diff',
          status: r.proposedExit === ExitCode.Failure ? 'failed' : 'passed',
          severity: 'error',
          counts: { errors: r.counts.error, warnings: r.counts.warning, rules: r.selectedRuleIds.length },
          violations: r.violations.map((v) => ({ id: v.importSpecifier, file: v.file, line: v.line, message: v.message })),
          coverage,
        });
      }
    }

    // 3. Import-hygiene engine — over the changed sources it actually reads.
    let importsBlock: IDiffCheckEnvelope['imports'] = {
      ran: false,
      verdict: 'skipped',
      counts: {},
      findings: [],
    };
    const hygieneFiles = changedFiles.length > 0 ? importHygieneSubjects(cwd, changedFiles) : [];
    if (changedFiles.length === 0) {
      importsBlock.reason = 'no changed files in the diff scope';
    } else if (hygieneFiles.length === 0) {
      importsBlock.reason = 'no changed .ts/.tsx source for import hygiene to read';
    } else {
      const report = buildImportHygieneReport(cwd, { files: changedFiles });
      importsBlock = {
        ran: true,
        verdict: report.verdict,
        counts: report.counts ?? {},
        findings: report.findings as unknown as ReadonlyArray<Record<string, unknown>>,
      };
      rows.push({
        id: 'imports',
        type: 'diff',
        status: report.verdict === 'errors' ? 'failed' : 'passed',
        severity: 'error',
        counts: { findings: report.findings.length },
        violations: report.findings
          .filter((f) => f.severity === 'error')
          .map((f) => ({ id: f.kind, file: f.file, line: f.line })),
        // THE hygiene coverage fold — an unreadable changed source is unexamined.
        coverage: importHygieneCoverage(report, 'changed source files'),
      });
    }

    // 4. Settle the verdict through the shared envelope.
    const runCoverage: IVerdictCoverage = {
      unit: 'sub-checks',
      expected: rows.length,
      examined: rows.length,
      ...(rows.length === 0
        ? {
            reason:
              changedFiles.length === 0
                ? 'no changed files in the diff scope'
                : 'nothing in the diff is governed by a boundary rule or read by import hygiene',
          }
        : {}),
      ...allowEmptyValve(args, rows.length),
    };
    const proposed = rows.some((r) => r.status === 'failed') ? ExitCode.Failure : ExitCode.VerifiedPass;
    const env = buildGateEnvelope('diff-check', proposed, rows, runCoverage);
    const exit = env.exit;

    const bErr = boundaryBlock.counts.error;
    const bWarn = boundaryBlock.counts.warning;
    const bErrored = (boundaryBlock.loadIssues?.length ?? 0) + (boundaryBlock.staleExceptions?.length ?? 0);
    const iErr = importsBlock.verdict === 'errors' ? (importsBlock.counts.error ?? importsBlock.findings.length) : 0;
    const iWarn = importsBlock.verdict === 'warnings' ? (importsBlock.counts.warning ?? importsBlock.findings.length) : 0;
    let verdict: IDiffCheckEnvelope['verdict'];
    let summary: string;
    let nextAction: string;
    if (exit === ExitCode.Failure) {
      const parts: string[] = [];
      if (bErr > 0) parts.push(plural(bErr, 'boundary violation'));
      if (bErrored > 0) parts.push(plural(bErrored, 'errored boundary rule / stale exception'));
      if (iErr > 0) parts.push(plural(iErr, 'import-hygiene error'));
      verdict = 'errors';
      summary = `Diff fails the gate: ${parts.join(', ') || 'see the failing check'}.`;
      nextAction =
        'Fix every error in `boundaries.violations` and `imports.findings` (look at each entry\'s `suggestedFix` line), then re-run `shrk diff-check`.';
    } else if (exit !== ExitCode.VerifiedPass) {
      verdict = 'not-verified';
      summary =
        rows.length === 0
          ? changedFiles.length === 0
            ? 'No files changed in the current diff scope — nothing was checked (this is not a pass).'
            : 'Nothing in the diff is governed by a boundary rule or read by import hygiene — nothing was checked (this is not a pass).'
          : `Not verified: ${env.shortfalls.slice(0, 3).join('; ')} — this is NOT a pass.`;
      nextAction =
        rows.length === 0
          ? `Nothing was verified. If you expected changes, check your \`--staged\` / \`--since <ref>\` flag or save your edits first; pass --${ALLOW_EMPTY_FLAG} to accept an empty diff explicitly.`
          : 'Part of the scope was never examined — fix the rule scope named above, then re-run `shrk diff-check`.';
    } else if (rows.length === 0) {
      verdict = 'ok';
      summary = 'Nothing to check — the empty diff was accepted explicitly.';
      nextAction = 'Nothing was gated.';
    } else if (bWarn > 0 || iWarn > 0) {
      const parts: string[] = [];
      if (bWarn > 0) parts.push(plural(bWarn, 'boundary warning'));
      if (iWarn > 0) parts.push(plural(iWarn, 'import-hygiene warning'));
      verdict = 'warnings';
      summary = `Diff passes the gate with ${parts.join(', ')}.`;
      nextAction =
        'Safe to declare done. Review warnings if the diff touches a sensitive area; otherwise these are non-blocking.';
    } else {
      verdict = 'ok';
      summary = `Diff passes the gate (${plural(changedFiles.length, 'file')}, 0 violations).`;
      nextAction = 'Safe to declare done.';
    }
    const envelope: IDiffCheckEnvelope = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      scope: { mode, files: changedFiles, fileCount: changedFiles.length },
      boundaries: boundaryBlock,
      imports: importsBlock,
      verdict,
      summary,
      nextAction,
      exitCode: exit,
      gate: env,
    };

    // 5. Render.
    if (wantJson) {
      process.stdout.write(asJson(envelope) + '\n');
      return exit;
    }
    process.stdout.write(header('Diff check'));
    process.stdout.write(kv('scope', `${envelope.scope.mode} (${plural(envelope.scope.fileCount, 'file')})`) + '\n');
    process.stdout.write(
      kv(
        'boundaries',
        boundaryBlock.ran
          ? `${bErr} errors, ${bWarn} warnings${boundaryBlock.escalation ? ` — ${boundaryBlock.escalation.ruleIds.length} rule(s) escalated (${boundaryBlock.escalation.files.join(', ')} changed)` : ''}`
          : `(not run — ${boundaryBlock.reason ?? 'nothing to check'})`,
      ) + '\n',
    );
    process.stdout.write(
      kv(
        'imports',
        importsBlock.ran
          ? `verdict=${importsBlock.verdict} (${plural(importsBlock.findings.length, 'finding')})`
          : `(not run — ${importsBlock.reason ?? 'nothing to check'})`,
      ) + '\n',
    );
    process.stdout.write(kv('verdict', `${envelope.verdict} (exit ${exit})`) + '\n');
    if (exit === ExitCode.Failure) process.stdout.write(`\n${summary}\n`);
    if (boundaryBlock.violations.length > 0) {
      process.stdout.write('\nBoundary violations:\n');
      for (const v of boundaryBlock.violations.slice(0, 10)) {
        const file = String(v.file ?? '');
        const rule = String(v.ruleId ?? '');
        const fix = v.suggestedFix ? ` — ${String(v.suggestedFix)}` : '';
        process.stdout.write(bullet(`${rule} in ${file}${fix}`) + '\n');
      }
      if (boundaryBlock.violations.length > 10) {
        process.stdout.write(`  … and ${boundaryBlock.violations.length - 10} more (pass --json for full list).\n`);
      }
    }
    if (importsBlock.findings.length > 0) {
      process.stdout.write('\nImport findings:\n');
      for (const f of importsBlock.findings.slice(0, 10)) {
        const file = String(f.path ?? f.file ?? '');
        const kind = String(f.kind ?? '');
        process.stdout.write(bullet(`${kind} in ${file}`) + '\n');
      }
      if (importsBlock.findings.length > 10) {
        process.stdout.write(`  … and ${importsBlock.findings.length - 10} more (pass --json for full list).\n`);
      }
    }
    // The final line comes from the SETTLED verdict — the clean sentence only at 0.
    const line = verdictLine(env, `${summary} ✓`, exit === ExitCode.NotVerified ? summary : undefined);
    if (line) process.stdout.write(`\n${line}\n`);
    process.stdout.write(`\nNext: ${nextAction}\n`);
    return exit;
  },
};
