import { spawnSync } from 'node:child_process';

/**
 * Generous ceiling for git stdout captured by {@link runGitLines}. Every call
 * site only ever asks git for a *name list* (`--name-only` / `--name-status`),
 * never diff bodies, so the real output is one short line per changed path.
 *
 * Node's `spawnSync`/`execSync` default `maxBuffer` is 1 MB, and on a large
 * uncommitted changeset a name listing overflows it — the child dies with
 * `ENOBUFS` and the old `execSync(`git diff … ${ref}`)` sites threw. 512 MB is
 * ~10 million paths: effectively unbounded for a name list while still capping
 * a pathological runaway instead of letting it consume all memory.
 */
const GIT_LINES_MAX_BUFFER = 512 * 1024 * 1024;

/** Outcome of a {@link runGitLines} call. Never carries a thrown exception. */
export interface IGitLinesResult {
  /** True when git exited 0 and its output was captured without overflow. */
  readonly ok: boolean;
  /** Trimmed, non-empty stdout lines (left exactly as git emitted them). */
  readonly lines: readonly string[];
  /** Populated only when `ok` is false. */
  readonly error?: string;
}

/**
 * Run `git <args>` in `cwd` and return stdout split into trimmed, non-empty
 * lines. The hardened replacement for the scattered `execSync(`git … ${ref}`)`
 * / `spawnSync('git', …)` call sites that buffered an unbounded git blob:
 *
 *  - **No shell.** Args are passed as an argv array, so a ref/path is never
 *    re-interpreted by `/bin/sh` — this removes both the shell-injection
 *    surface and the `spawnSync /bin/sh ENOBUFS` failure mode.
 *  - **Bounded but huge.** {@link GIT_LINES_MAX_BUFFER} replaces Node's 1 MB
 *    default, so a large-diff name listing no longer overflows the pipe.
 *  - **Never throws.** Spawn errors (incl. a maxBuffer overflow) and non-zero
 *    exits return `{ ok: false, error }`, so callers degrade to whole-tree
 *    mode cleanly instead of crashing.
 *
 * Deterministic: identical git state + args → identical lines.
 */
export function runGitLines(cwd: string, args: readonly string[]): IGitLinesResult {
  const res = spawnSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_LINES_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    return { ok: false, lines: [], error: res.error.message };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? '').toString().trim();
    return {
      ok: false,
      lines: [],
      error: stderr.length > 0 ? stderr : `git exited with status ${res.status ?? 'unknown'}`,
    };
  }
  const lines = (res.stdout ?? '')
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { ok: true, lines };
}
