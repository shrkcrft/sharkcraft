/**
 * `shrk preflight` — changed-only orchestrator.
 *
 * Pre-commit-friendly entry that:
 *   1. Resolves the changed-file set (`--since <ref>` / `--staged` /
 *      `--files a,b,c` / default working-tree).
 *   2. Plans gates from the changed-file shape (see `changed-preflight.ts`).
 *   3. Either prints the plan (`--explain`) or runs the `Run` gates.
 *
 * Never auto-applies fixes. Read-only by default. The `Recommend` gates
 * are surfaced but not executed unless `--strict` or the explicit
 * `--profile strict` is selected.
 */
import {
  planChangedPreflight,
  PreflightAction,
  PreflightProfile,
  renderChangedPreflightText,
  resolveChangedFiles,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

function parseProfile(value: string | undefined): PreflightProfile {
  if (value === 'quick') return PreflightProfile.Quick;
  if (value === 'strict') return PreflightProfile.Strict;
  return PreflightProfile.Standard;
}

async function runCommand(cmd: string, cwd: string): Promise<{ exitCode: number; durationMs: number }> {
  const start = Date.now();
  const child = await import('node:child_process');
  const r = child.spawnSync('bash', ['-lc', cmd], { cwd, stdio: 'inherit' });
  return { exitCode: r.status ?? 0, durationMs: Date.now() - start };
}

export const preflightCommand: ICommandHandler = {
  name: 'preflight',
  description:
    'Changed-only preflight orchestrator. Picks the right read-only gates from the changed-file set and runs them. Never writes; never auto-fixes. Pass --explain to see the plan without executing.',
  usage:
    'shrk preflight [--since <ref>] [--staged] [--files a,b,c] [--profile quick|standard|strict] [--explain] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const since = flagString(args, 'since');
    const staged = flagBool(args, 'staged');
    const filesArg = flagString(args, 'files');
    const profile = parseProfile(flagString(args, 'profile'));
    const explainOnly = flagBool(args, 'explain');

    const resolveOpts: {
      projectRoot: string;
      since?: string;
      staged?: boolean;
      files?: readonly string[];
      includeWorktree?: boolean;
    } = { projectRoot: cwd };
    if (filesArg) {
      resolveOpts.files = filesArg
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (staged) {
      resolveOpts.staged = true;
    } else if (since) {
      resolveOpts.since = since;
    } else {
      resolveOpts.includeWorktree = true;
    }
    const changed = resolveChangedFiles(resolveOpts);
    const plan = planChangedPreflight({
      projectRoot: cwd,
      changedFiles: changed.files,
      profile,
    });

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ plan, scopeMode: changed.mode }) + '\n');
      return 0;
    }

    process.stdout.write(header(`Changed-only preflight (${profile})`));
    process.stdout.write(renderChangedPreflightText(plan));

    if (explainOnly) return 0;

    // Run the `Run` gates sequentially. Track first failure but continue
    // through the rest so the operator sees the full picture, mirroring
    // the dev-cycle orchestrator.
    const runGates = plan.gates.filter((g) => g.action === PreflightAction.Run);
    if (runGates.length === 0) {
      process.stdout.write('\nNo gates need to run for this change-set.\n');
      return 0;
    }
    let firstFailure: { id: string; exitCode: number } | null = null;
    const log: { id: string; exitCode: number; durationMs: number }[] = [];
    for (const g of runGates) {
      process.stdout.write(`\n=== [${g.id}] ${g.command} ===\n`);
      const r = await runCommand(g.command, cwd);
      log.push({ id: g.id, exitCode: r.exitCode, durationMs: r.durationMs });
      if (r.exitCode !== 0 && !g.canFail && !firstFailure) {
        firstFailure = { id: g.id, exitCode: r.exitCode };
      }
    }
    process.stdout.write('\n=== Preflight summary ===\n');
    for (const e of log) {
      process.stdout.write(
        `  ${e.exitCode === 0 ? 'OK   ' : 'FAIL '} ${e.id.padEnd(22)} (${e.durationMs}ms)\n`,
      );
    }
    const recommended = plan.gates.filter((g) => g.action === PreflightAction.Recommend);
    if (recommended.length > 0) {
      process.stdout.write('\nRecommended (not run):\n');
      for (const r of recommended) {
        process.stdout.write(`  • ${r.command}  — ${r.reason}\n`);
      }
    }
    return firstFailure ? 1 : 0;
  },
};
