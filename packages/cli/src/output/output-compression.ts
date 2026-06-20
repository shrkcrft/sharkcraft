import { spawnSync } from 'node:child_process';
import { compressContent, type ICompressOptions } from '@shrkcrft/compress';
import type { IGlobalCompressDirective } from '../command-registry.ts';
import { openCcrStore } from './ccr-store-config.ts';
import { resolveCompressType } from './resolve-compress-type.ts';

// Command output can be large (a full knowledge dump, a wide graph). Allow up to
// 64 MiB of captured stdout before spawnSync gives up.
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Implements the global `--compress` / `--ccr` flag: run a `shrk` command in a
 * child process, capture its stdout, and emit a deterministically-compressed
 * version (with the original cached for `shrk expand`). The command's own
 * stderr is forwarded verbatim and its exit code is preserved.
 *
 * A SUBPROCESS (not in-process `process.stdout` capture) on purpose: some
 * commands call `process.exit`, which would discard a buffered in-process
 * capture mid-write; re-running the command isolates that and still yields the
 * full output + real exit status. `childArgv` has already had the compress
 * flags stripped, so the child never recurses.
 */
export function runCommandWithCompression(
  childArgv: readonly string[],
  directive: IGlobalCompressDirective,
  cwd: string,
): number {
  const runtime = process.argv[0];
  const entry = process.argv[1];
  if (!runtime || !entry) {
    process.stderr.write(
      '--compress: cannot determine the shrk entry point to re-run; emitting uncompressed.\n',
    );
    return 1;
  }

  // Resolve an explicit --compress-type up front so a typo is reported loudly
  // (not silently auto-detected), even if the command ends up printing nothing.
  const resolvedType = resolveCompressType(directive.type);
  if (resolvedType.warning) process.stderr.write(`${resolvedType.warning}\n`);

  const res = spawnSync(runtime, [entry, ...childArgv], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: process.env,
  });
  if (res.error) {
    process.stderr.write(
      `--compress: failed to run the command (${res.error.message}); emitting nothing.\n`,
    );
    return 1;
  }
  // Forward the command's own stderr (warnings, summaries, errors) untouched.
  if (res.stderr) process.stderr.write(res.stderr);

  const captured = res.stdout ?? '';
  const code = res.status ?? (res.signal ? 1 : 0);
  // Nothing on stdout (or the command failed) → don't fabricate output.
  if (captured.length === 0) return code;

  const opts: ICompressOptions = { store: openCcrStore(cwd) };
  if (directive.query) opts.query = directive.query;
  if (resolvedType.type) opts.contentType = resolvedType.type;

  const result = compressContent(captured, opts);
  process.stdout.write(
    result.compressed.endsWith('\n') ? result.compressed : `${result.compressed}\n`,
  );
  const pct = Math.round(result.savings.ratio * 100);
  const cached = result.ccrKey ? ` · original cached (shrk expand ${result.ccrKey})` : '';
  process.stderr.write(
    `[--compress] ${result.strategy}: ~${result.savings.before} → ~${result.savings.after} tokens (−${pct}%, est.)${cached}\n`,
  );
  return code;
}
