import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import {
  compressContent,
  ECompressionStrategy,
  EContentType,
  type ICompressOptions,
} from '@shrkcrft/compress';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';
import { ccrDir, openCcrStore } from '../output/ccr-store-config.ts';

const CONTENT_TYPES = new Set<string>(Object.values(EContentType));

function readInput(args: ParsedArgs): string {
  const positional = args.positional[0];
  const useStdin = flagBool(args, 'stdin') || positional === undefined || positional === '-';
  if (useStdin) return readFileSync(0, 'utf8');
  return readFileSync(positional, 'utf8');
}

/**
 * `shrk compress` — deterministically compress a blob (file or stdin) before
 * it re-enters an agent prompt. Same information, fewer tokens. Lossy passes
 * cache the original under `.sharkcraft/ccr/` so `shrk expand <key>` can get
 * it back. The compressed text goes to stdout (pipeable); the savings summary
 * goes to stderr unless `--json` is set.
 */
const COMPRESS_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'stdin',
  'lossless',
  'no-cache',
  'json',
]);

export const compressCommand: ICommandHandler = {
  name: 'compress',
  description:
    'Compress a blob (file or stdin) deterministically to cut tokens — JSON→table, logs/search/diffs→signal. Reversible via `shrk expand`.',
  usage:
    'shrk [--cwd <dir>] compress [<file>|-] [--stdin] [--type <content-type>] [--query <text>] [--max <n>] [--lossless] [--no-cache] [--json]',
  booleanFlags: COMPRESS_BOOLEAN_FLAGS,
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    let content: string;
    try {
      content = readInput(args);
    } catch (e) {
      process.stderr.write(`compress: cannot read input — ${(e as Error).message}\n`);
      return 1;
    }
    if (content.length === 0) {
      process.stderr.write('compress: empty input.\n');
      return 1;
    }

    const opts: ICompressOptions = {};
    if (!flagBool(args, 'no-cache')) opts.store = openCcrStore(cwd);
    const query = flagString(args, 'query');
    if (query) opts.query = query;
    const max = flagNumber(args, 'max');
    if (max !== undefined && max > 0) opts.maxItems = Math.floor(max);
    if (flagBool(args, 'lossless')) opts.lossless = true;
    const type = flagString(args, 'type');
    if (type && CONTENT_TYPES.has(type)) opts.contentType = type as EContentType;

    const result = compressContent(content, opts);
    const pct = Math.round(result.savings.ratio * 100);

    // A lossy result with no cached original (i.e. --no-cache) can't be undone
    // by `shrk expand`. Warn so the dropped detail isn't lost silently.
    if (result.lossy && !result.ccrKey) {
      process.stderr.write(
        'warning: compressed lossily but the original was NOT cached (--no-cache) — ' +
          'detail is unrecoverable; omit --no-cache to keep it retrievable via `shrk expand`.\n',
      );
    }

    const queryApplied = query !== undefined && query.length > 0;

    if (flagBool(args, 'json')) {
      // tokens are a deterministic ESTIMATE (chars/divisor heuristic), not a
      // real BPE count — flagged so callers don't treat savedRatio as exact.
      const base = {
        contentType: result.contentType,
        strategy: result.strategy,
        lossy: result.lossy,
        tokensBefore: result.savings.before,
        tokensAfter: result.savings.after,
        tokensSaved: result.savings.saved,
        savedRatio: result.savings.ratio,
        tokensAreEstimated: true,
        queryApplied,
        ccrKey: result.ccrKey ?? null,
        note: result.note,
      };
      // Net-loss guard: on a passthrough/no-win blob the engine returns the
      // VERBATIM original as `compressed`. Echoing it back inside the JSON
      // envelope (plus scaffold) costs more tokens than the input. Signal
      // passthrough and omit the duplicated content — the caller still has it.
      const noWin = result.strategy === ECompressionStrategy.Passthrough || result.savings.saved <= 0;
      const payload = noWin
        ? { ...base, passthrough: true, inputBytes: Buffer.byteLength(content, 'utf8') }
        : { ...base, compressed: result.compressed };
      process.stdout.write(asJson(payload) + '\n');
      return 0;
    }

    process.stdout.write(result.compressed + '\n');
    const cached = result.ccrKey ? ` · original cached as ${result.ccrKey} (shrk expand ${result.ccrKey})` : '';
    process.stderr.write(
      `${result.strategy}: ~${result.savings.before} → ~${result.savings.after} tokens (−${pct}%, est.)${cached}\n`,
    );
    return 0;
  },
};

/**
 * `shrk expand` — the retrieve half of CCR. Print the full original that
 * `shrk compress` cached for a `<<ccr:KEY>>` key.
 */
export const expandCommand: ICommandHandler = {
  name: 'expand',
  description: 'Retrieve the full original a `shrk compress` run cached, by its `<<ccr:KEY>>` key.',
  usage: 'shrk [--cwd <dir>] expand <key> [--json]',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    const key = (args.positional[0] ?? '').trim();
    if (key.length === 0) {
      process.stderr.write('expand: a CCR key is required (e.g. `shrk expand a1b2c3d4e5f60718`).\n');
      return 1;
    }
    const store = openCcrStore(cwd);
    const entry = store.get(key);
    if (!entry) {
      process.stderr.write(
        `expand: no cached original for key "${key}" under ${ccrDir(cwd)}.\n`,
      );
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ key: entry.key, bytes: entry.bytes, content: entry.content }) + '\n');
      return 0;
    }
    // Write the cached original VERBATIM — appending a newline broke byte-for-byte
    // round-trip (`compress … ; expand` must reproduce the input exactly).
    process.stdout.write(entry.content);
    return 0;
  },
};
