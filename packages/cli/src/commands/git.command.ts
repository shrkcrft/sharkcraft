import {
  getChangedFiles,
  getGitBranch,
  getGitRoot,
  getStatusSummary,
  isGitRepo,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const gitChangedCommand: ICommandHandler = {
  name: 'changed',
  description: 'List changed files (read-only git diff).',
  usage: 'shrk git changed [--since <ref>] [--staged] [--include-worktree] [--json]',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    if (!isGitRepo(cwd)) {
      process.stderr.write('Not a git repo.\n');
      return 1;
    }
    const opts: { since?: string; staged?: boolean; includeWorktree?: boolean } = {};
    const since = flagString(args, 'since');
    if (since) opts.since = since;
    if (flagBool(args, 'staged')) opts.staged = true;
    if (flagBool(args, 'include-worktree')) opts.includeWorktree = true;
    const files = getChangedFiles(cwd, opts);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ files }) + '\n');
    } else {
      for (const f of files) process.stdout.write(`${f}\n`);
    }
    return 0;
  },
};

export const gitRootCommand: ICommandHandler = {
  name: 'root',
  description: 'Print the git repo root.',
  usage: 'shrk git root',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    const r = getGitRoot(cwd);
    if (!r) {
      process.stderr.write('Not a git repo.\n');
      return 1;
    }
    process.stdout.write(r + '\n');
    return 0;
  },
};

export const gitBranchCommand: ICommandHandler = {
  name: 'branch',
  description: 'Print the current git branch.',
  usage: 'shrk git branch',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    const b = getGitBranch(cwd);
    if (!b) {
      process.stderr.write('Not a git repo.\n');
      return 1;
    }
    process.stdout.write(b + '\n');
    return 0;
  },
};

export const gitStatusSummaryCommand: ICommandHandler = {
  name: 'status-summary',
  description: 'Compact, read-only git status summary.',
  usage: 'shrk git status-summary [--json]',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    const summary = getStatusSummary(cwd);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(summary) + '\n');
      return 0;
    }
    process.stdout.write(
      `branch=${summary.branch ?? '(none)'} ` +
        `ahead=${summary.ahead} behind=${summary.behind} ` +
        `staged=${summary.staged} modified=${summary.modified} ` +
        `untracked=${summary.untracked} conflicts=${summary.conflicts} ` +
        `clean=${summary.clean}\n`,
    );
    return 0;
  },
};
