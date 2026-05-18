import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';

export interface IGitChangedOptions {
  /** Compare against the given ref (HEAD, origin/main, a SHA, …). */
  since?: string;
  /** When true, only staged (index) changes. */
  staged?: boolean;
  /** When true, include the unstaged working-tree changes too. */
  includeWorktree?: boolean;
}

export interface IGitStatusSummary {
  branch: string | null;
  root: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
  clean: boolean;
}

function runGit(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('git', args as string[], { cwd, encoding: 'utf8' });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').toString(),
    stderr: (res.stderr ?? '').toString(),
  };
}

export function isGitRepo(cwd: string): boolean {
  if (existsSync(nodePath.join(cwd, '.git'))) return true;
  const r = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

export function getGitRoot(cwd: string): string | null {
  const r = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}

export function getGitBranch(cwd: string): string | null {
  const r = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}

export function getChangedFiles(cwd: string, opts: IGitChangedOptions = {}): string[] {
  if (!isGitRepo(cwd)) return [];
  const args = ['diff', '--name-only'];
  if (opts.staged) args.push('--cached');
  if (opts.since) args.push(opts.since);
  const a = runGit(cwd, args);
  const set = new Set<string>(parseLines(a.stdout));
  if (opts.includeWorktree && !opts.staged && !opts.since) {
    // Include untracked + working-tree changes via `git status --porcelain`.
    const s = runGit(cwd, ['status', '--porcelain']);
    if (s.ok) {
      for (const line of s.stdout.split('\n')) {
        const trimmed = line.slice(3).trim();
        if (trimmed) set.add(trimmed);
      }
    }
  }
  return [...set].sort();
}

export function getStatusSummary(cwd: string): IGitStatusSummary {
  const empty: IGitStatusSummary = {
    branch: null,
    root: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    clean: true,
  };
  if (!isGitRepo(cwd)) return empty;
  const r = runGit(cwd, ['status', '--porcelain=2', '--branch']);
  if (!r.ok) return empty;
  const out: IGitStatusSummary = { ...empty };
  out.root = getGitRoot(cwd);
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('# branch.head')) {
      out.branch = line.slice('# branch.head'.length).trim();
    } else if (line.startsWith('# branch.ab')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.split(' ')[1] ?? '..';
      const x = xy[0] ?? '.';
      const y = xy[1] ?? '.';
      if (x !== '.') out.staged += 1;
      if (y !== '.') out.modified += 1;
    } else if (line.startsWith('u ')) {
      out.conflicts += 1;
    } else if (line.startsWith('? ')) {
      out.untracked += 1;
    }
  }
  out.clean =
    out.staged === 0 && out.modified === 0 && out.untracked === 0 && out.conflicts === 0;
  return out;
}

export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
