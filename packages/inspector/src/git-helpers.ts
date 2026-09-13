import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { detectProjectRoot } from '@shrkcrft/workspace';

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

// 512 MB — the same generous ceiling @shrkcrft/shared's runGitLines uses. A
// `diff`/`log --name-only` listing on a large changeset overflows Node's 1 MB
// default `maxBuffer` and dies with ENOBUFS; a name listing never approaches
// 512 MB, so this is effectively unbounded while still capping a runaway.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

function runGit(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
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

/**
 * Where `dir` sits inside its git work tree (`git rev-parse --show-prefix`):
 * `''` at the top level, `app/` for a project nested in a larger repository.
 * `''` too when git cannot tell (the paths are then used as git printed them).
 */
function gitPrefix(dir: string): string {
  const r = runGit(dir, ['rev-parse', '--show-prefix']);
  return r.ok ? r.stdout.trim() : '';
}

/** A top-level-relative git path as a root-relative one, or `undefined` outside the root's subtree. */
function underPrefix(prefix: string, gitPath: string): string | undefined {
  if (prefix === '') return gitPath;
  return gitPath.startsWith(prefix) && gitPath.length > prefix.length ? gitPath.slice(prefix.length) : undefined;
}

/**
 * The project root `cwd` belongs to — THE root `inspectSharkcraft` reads
 * (`detectProjectRoot`: the nearest ancestor holding a root marker, `.git`
 * included, so it never climbs out of the work tree). Every changed-scope path
 * is spelled relative to it, from whichever subdirectory a command runs.
 */
function changedScopeRoot(cwd: string): string {
  return detectProjectRoot(cwd).root;
}

/**
 * The files a change touched, RELATIVE TO THE PROJECT ROOT `cwd` belongs to
 * (`changedScopeRoot` — the root every caller resolves them against), sorted.
 * git names a path relative to the work-tree TOP LEVEL. That is always true of
 * `status --porcelain`, and of `diff` too once `diff.relative` is forced off,
 * so a user's config cannot change the spelling. For a project nested in a
 * larger repository (prefix `app/`), the top-level spelling `app/src/a.ts`
 * resolved to `<root>/app/src/a.ts`, a file that does not exist. A
 * changed-scope check (`conventions check --staged`, `--since`, and every
 * other changed-scope reader) then checked nothing (round 15 lane B, B4). Every
 * path is now mapped to root-relative. A change outside the project's subtree
 * (a sibling package of the larger repository) is not in scope.
 *
 * Root-relative, never `cwd`-relative (lane B review): a command run from a
 * subdirectory (`--cwd src`, a shell in `src/`) inspects the project root
 * `detectProjectRoot` walks up to, so a `cwd`-relative `a.ts` resolved to
 * `<root>/a.ts` — `validate-change`, `ownership affected`, `brief`, `tests
 * impact` and `finish` read the wrong files where the top-level spelling had
 * read the right ones.
 */
export function getChangedFiles(cwd: string, opts: IGitChangedOptions = {}): string[] {
  if (!isGitRepo(cwd)) return [];
  const root = changedScopeRoot(cwd);
  const prefix = gitPrefix(root);
  const args = ['-c', 'diff.relative=false', 'diff', '--name-only'];
  if (opts.staged) args.push('--cached');
  if (opts.since) args.push(opts.since);
  const a = runGit(root, args);
  const set = new Set<string>();
  const add = (gitPath: string): void => {
    const rel = underPrefix(prefix, gitPath);
    if (rel !== undefined) set.add(rel);
  };
  for (const p of parseLines(a.stdout)) add(p);
  if (opts.includeWorktree && !opts.staged && !opts.since) {
    // Include untracked + working-tree changes via `git status --porcelain`.
    // `-uall` expands untracked directories to individual files (default
    // `--porcelain` collapses them to a single `dir/` entry, which undercounts);
    // `.gitignore` is still honored.
    const s = runGit(root, ['status', '--porcelain', '-uall']);
    if (s.ok) {
      for (const line of s.stdout.split('\n')) {
        // Strip the two-char XY status + leading space, then take the new path
        // for rename/copy entries (`R  old -> new`).
        const raw = line.slice(3).trim();
        const path = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4).trim() : raw;
        if (path) add(path);
      }
    }
  }
  return [...set].sort();
}

/**
 * True when `ref` resolves to a commit in `cwd`'s repo. Lets a caller tell a
 * genuinely-empty diff apart from a bad ref — `getChangedFiles` returns `[]` for
 * both (a failed `git diff <bad-ref>` yields no names), so a gate that scopes on
 * `--base <ref>` must validate the ref first or it reports "nothing changed"
 * (a false verified-nothing) over a typo'd ref.
 */
export function refExists(cwd: string, ref: string): boolean {
  if (!ref) return false;
  const r = runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * The content of `relPath` at `ref` (e.g. `git show HEAD:./src/x.ts`), or
 * `null` when the path did not exist at that ref (a newly-added file) or git
 * failed. `relPath` is relative to the project root `cwd` belongs to — the
 * spelling `getChangedFiles` returns: git runs from that root and the `./` form
 * resolves the path against it, so a project nested in a larger repository
 * reads its own file (round 15 lane B, B4; the bare `<ref>:<path>` form is
 * top-level-relative), and so does a caller whose `cwd` is a subdirectory
 * (lane B review). Used to diff a file's PAST state against the working tree
 * without a checkout — e.g. to see what a now-edited file used to
 * provide/register.
 */
export function gitShowFile(cwd: string, ref: string, relPath: string): string | null {
  const r = runGit(changedScopeRoot(cwd), ['show', `${ref}:./${relPath.replace(/^\.\//, '')}`]);
  return r.ok ? r.stdout : null;
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

export interface ICommitInfo {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
  readonly files: readonly string[];
}

/**
 * Commit subjects (and the files each touched) in the range `<since>..HEAD`,
 * newest first. Deterministic (git only; no model). Returns [] outside a git
 * repo or on any git error. Used by `knowledge propose` to annotate drafted
 * entries with the commit that surfaced them ("why this entry now").
 */
export function getCommitSubjects(cwd: string, opts: { since: string }): ICommitInfo[] {
  if (!isGitRepo(cwd)) return [];
  const range = `${opts.since}..HEAD`;
  // NUL-delimited records: \0<hash>\t<subject> then one file path per line.
  const r = runGit(cwd, [
    'log',
    '--no-merges',
    '--name-only',
    '--pretty=format:%x00%H%x09%s',
    range,
  ]);
  if (!r.ok) return [];
  const out: ICommitInfo[] = [];
  for (const chunk of r.stdout.split('\0')) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const header = lines[0] ?? '';
    const tab = header.indexOf('\t');
    if (tab < 0) continue;
    const hash = header.slice(0, tab).trim();
    if (!hash) continue;
    const subject = header.slice(tab + 1).trim();
    const files = lines
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    out.push({ hash, shortHash: hash.slice(0, 8), subject, files });
  }
  return out;
}

export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
