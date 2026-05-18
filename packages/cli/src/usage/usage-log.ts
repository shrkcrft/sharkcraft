import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Local-only command usage log. Writes one JSONL entry per
 * command invocation to `.sharkcraft/usage/commands.jsonl`. Opt-out
 * via `sharkcraft.config.ts usage.enabled = false` OR
 * `SHARKCRAFT_USAGE_DISABLED=1`.
 *
 * Hard contracts:
 *   - Local only. NEVER sent anywhere; no network code touches this file.
 *   - Flag VALUES are never recorded. Only flag NAMES (the `--name`
 *     part, with the `--` stripped).
 *   - Rotates at 10MB to `commands.jsonl.1`; only one rotated file
 *     kept (the previous .1 is overwritten).
 *   - Append-only writes; failures degrade silently — the CLI must
 *     never fail because the usage log couldn't be written.
 */

export const USAGE_LOG_SCHEMA = 'sharkcraft.usage.v1';
export const USAGE_LOG_DIR = '.sharkcraft/usage';
export const USAGE_LOG_FILE = 'commands.jsonl';
export const USAGE_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export interface IUsageEntry {
  schemaVersion: typeof USAGE_LOG_SCHEMA;
  ts: string;
  command: string;
  exitCode: number;
  durationMs: number;
  /** Flag names (with leading `--` stripped). Never values. */
  flags: readonly string[];
}

export interface IUsageRecordOptions {
  cwd: string;
  command: string;
  exitCode: number;
  durationMs: number;
  flags: readonly string[];
  /** When false (or env var set), the writer is a no-op. */
  enabled: boolean;
}

export function recordUsage(opts: IUsageRecordOptions): void {
  if (!opts.enabled) return;
  if (process.env.SHARKCRAFT_USAGE_DISABLED === '1') return;

  const dir = nodePath.join(opts.cwd, USAGE_LOG_DIR);
  const file = nodePath.join(dir, USAGE_LOG_FILE);
  const entry: IUsageEntry = {
    schemaVersion: USAGE_LOG_SCHEMA,
    ts: new Date().toISOString(),
    command: opts.command,
    exitCode: opts.exitCode,
    durationMs: Math.max(0, Math.round(opts.durationMs)),
    flags: opts.flags,
  };
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    rotateIfTooBig(file);
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Silent. The CLI must never fail because of the usage log.
  }
}

function rotateIfTooBig(file: string): void {
  if (!existsSync(file)) return;
  try {
    const size = statSync(file).size;
    if (size < USAGE_LOG_ROTATE_BYTES) return;
    const rotated = `${file}.1`;
    renameSync(file, rotated);
  } catch {
    // ignore
  }
}

/**
 * Sanitize raw argv into flag NAMES only. Drops values, drops
 * positional args, dedupes. Single-letter flags keep their dash.
 *
 * Examples:
 *   `["doctor", "--json"]`              → `["--json"]`
 *   `["task", "<task>", "--top", "5"]`  → `["--top"]`
 *   `["--cwd=foo", "--debug"]`          → `["--cwd", "--debug"]`
 */
export function sanitizeFlagNames(rawArgv: readonly string[]): string[] {
  const out = new Set<string>();
  for (let i = 0; i < rawArgv.length; i += 1) {
    const t = rawArgv[i]!;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      out.add(name);
      // If the flag took the NEXT positional as its value, skip it.
      if (eq === -1) {
        const next = rawArgv[i + 1];
        if (next !== undefined && !next.startsWith('-')) i += 1;
      }
    } else if (t.startsWith('-') && t.length > 1) {
      out.add(t);
    }
  }
  return [...out].sort();
}

/**
 * Extract the leading command path (top-level + first
 * subcommand if present, no flags) from raw argv.
 */
export function extractCommandPath(rawArgv: readonly string[]): string {
  const tokens: string[] = [];
  for (const t of rawArgv) {
    if (t.startsWith('-')) break;
    if (tokens.length >= 2) break;
    tokens.push(t);
  }
  return tokens.join(' ');
}
