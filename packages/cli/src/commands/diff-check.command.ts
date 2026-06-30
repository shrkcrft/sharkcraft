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
 *      verdict (ok / warnings / errors) and a one-line next action.
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
 * This is a pure composer — all real logic stays in
 * `@shrkcrft/inspector` and `@shrkcrft/boundaries`. We just stitch
 * their outputs together with consistent scoping.
 */

import {
  buildImportHygieneReport,
  filterViolationsToChangedScope,
  inspectSharkcraft,
  resolveChangedFiles,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import {
  evaluateBoundaries,
  loadTsconfigPaths,
  scanImports,
} from '@shrkcrft/boundaries';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, bullet, header, kv } from '../output/format-output.ts';

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
    rulesEvaluated: number;
    counts: { error: number; warning: number; info: number };
    violations: ReadonlyArray<Record<string, unknown>>;
  };
  imports: {
    ran: boolean;
    verdict: 'ok' | 'warnings' | 'errors' | 'skipped';
    counts: Readonly<Record<string, number>>;
    findings: ReadonlyArray<Record<string, unknown>>;
  };
  verdict: 'ok' | 'warnings' | 'errors';
  summary: string;
  nextAction: string;
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

function deriveVerdict(env: Omit<IDiffCheckEnvelope, 'verdict' | 'summary' | 'nextAction'>): {
  verdict: 'ok' | 'warnings' | 'errors';
  summary: string;
  nextAction: string;
} {
  const bErr = env.boundaries.counts.error;
  const bWarn = env.boundaries.counts.warning;
  const iErr = env.imports.verdict === 'errors' ? (env.imports.counts.error ?? env.imports.findings.length) : 0;
  const iWarn = env.imports.verdict === 'warnings' ? (env.imports.counts.warning ?? env.imports.findings.length) : 0;

  if (env.scope.fileCount === 0) {
    return {
      verdict: 'ok',
      summary: 'No files changed in the current diff scope.',
      nextAction:
        'Nothing to check. If you expected changes, verify your `--staged` / `--since <ref>` flag or save your edits first.',
    };
  }

  if (bErr > 0 || iErr > 0) {
    const parts: string[] = [];
    if (bErr > 0) parts.push(`${bErr} boundary violation${bErr === 1 ? '' : 's'}`);
    if (iErr > 0) parts.push(`${iErr} import-hygiene error${iErr === 1 ? '' : 's'}`);
    return {
      verdict: 'errors',
      summary: `Diff fails the gate: ${parts.join(', ')}.`,
      nextAction:
        'Fix every error in `boundaries.violations` and `imports.findings` (look at each entry\'s `suggestedFix` line), then re-run `shrk diff-check`.',
    };
  }

  if (bWarn > 0 || iWarn > 0) {
    const parts: string[] = [];
    if (bWarn > 0) parts.push(`${bWarn} boundary warning${bWarn === 1 ? '' : 's'}`);
    if (iWarn > 0) parts.push(`${iWarn} import-hygiene warning${iWarn === 1 ? '' : 's'}`);
    return {
      verdict: 'warnings',
      summary: `Diff passes the gate with ${parts.join(', ')}.`,
      nextAction:
        'Safe to declare done. Review warnings if the diff touches a sensitive area; otherwise these are non-blocking.',
    };
  }

  return {
    verdict: 'ok',
    summary: `Diff passes the gate (${env.scope.fileCount} file${env.scope.fileCount === 1 ? '' : 's'}, 0 violations).`,
    nextAction: 'Safe to declare done.',
  };
}

export const diffCheckCommand: ICommandHandler = {
  name: 'diff-check',
  description:
    'Self-check the current git diff against this project\'s boundary + import-hygiene rules. Single-call composite of `shrk check boundaries --changed-only` + `shrk check imports --changed-only`, with one verdict and one nextAction line. Designed for AI agents to run after editing — pass --json for the structured envelope.',
  usage:
    'shrk [--cwd <dir>] diff-check [files... | --files a.ts,b.ts | --staged | --since <ref>] [--json]',
  booleanFlags: new Set(['json', 'staged']),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const { mode, options: scopeOptions } = resolveScope(args, cwd);

    // 1. Resolve the changed file set once. Both engines re-use it.
    const changed = resolveChangedFiles(scopeOptions);
    const changedFiles = changed.files;

    // 2. Boundary engine — only if rules exist.
    const inspection = await inspectSharkcraft({ cwd });
    const rules = inspection.boundaryRegistry.list();
    let boundaryBlock: IDiffCheckEnvelope['boundaries'] = {
      ran: false,
      rulesEvaluated: 0,
      counts: { error: 0, warning: 0, info: 0 },
      violations: [],
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
    } else if (rules.length > 0 && changedFiles.length === 0) {
      boundaryBlock = { ...boundaryBlock, ran: true, rulesEvaluated: rules.length };
    }

    // 3. Import-hygiene engine — always runs, but scoped to changed files.
    let importsBlock: IDiffCheckEnvelope['imports'] = {
      ran: false,
      verdict: 'skipped',
      counts: {},
      findings: [],
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

    // 4. Build envelope + derive verdict.
    const partial: Omit<IDiffCheckEnvelope, 'verdict' | 'summary' | 'nextAction'> = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      scope: {
        mode,
        files: changedFiles,
        fileCount: changedFiles.length,
      },
      boundaries: boundaryBlock,
      imports: importsBlock,
    };
    const { verdict, summary, nextAction } = deriveVerdict(partial);
    const envelope: IDiffCheckEnvelope = { ...partial, verdict, summary, nextAction };

    // 5. Render.
    if (wantJson) {
      process.stdout.write(asJson(envelope) + '\n');
      return verdict === 'errors' ? 1 : 0;
    }
    process.stdout.write(header('Diff check'));
    process.stdout.write(kv('scope', `${envelope.scope.mode} (${envelope.scope.fileCount} file${envelope.scope.fileCount === 1 ? '' : 's'})`) + '\n');
    process.stdout.write(
      kv(
        'boundaries',
        envelope.boundaries.ran
          ? `${envelope.boundaries.counts.error} errors, ${envelope.boundaries.counts.warning} warnings`
          : '(no rules configured or no scoped files)',
      ) + '\n',
    );
    process.stdout.write(
      kv(
        'imports',
        envelope.imports.ran
          ? `verdict=${envelope.imports.verdict} (${envelope.imports.findings.length} finding${envelope.imports.findings.length === 1 ? '' : 's'})`
          : '(no scoped files)',
      ) + '\n',
    );
    process.stdout.write(kv('verdict', envelope.verdict) + '\n');
    process.stdout.write('\n');
    process.stdout.write(envelope.summary + '\n');
    if (envelope.boundaries.violations.length > 0) {
      process.stdout.write('\nBoundary violations:\n');
      for (const v of envelope.boundaries.violations.slice(0, 10)) {
        const file = String(v.file ?? '');
        const rule = String(v.ruleId ?? '');
        const fix = v.suggestedFix ? ` — ${String(v.suggestedFix)}` : '';
        process.stdout.write(bullet(`${rule} in ${file}${fix}`) + '\n');
      }
      if (envelope.boundaries.violations.length > 10) {
        process.stdout.write(`  … and ${envelope.boundaries.violations.length - 10} more (pass --json for full list).\n`);
      }
    }
    if (envelope.imports.findings.length > 0) {
      process.stdout.write('\nImport findings:\n');
      for (const f of envelope.imports.findings.slice(0, 10)) {
        const file = String(f.path ?? f.file ?? '');
        const kind = String(f.kind ?? '');
        process.stdout.write(bullet(`${kind} in ${file}`) + '\n');
      }
      if (envelope.imports.findings.length > 10) {
        process.stdout.write(`  … and ${envelope.imports.findings.length - 10} more (pass --json for full list).\n`);
      }
    }
    process.stdout.write(`\nNext: ${envelope.nextAction}\n`);
    return verdict === 'errors' ? 1 : 0;
  },
};
