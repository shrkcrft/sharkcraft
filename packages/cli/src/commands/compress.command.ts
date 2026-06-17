import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  compressContent,
  EContentType,
  FileCcrStore,
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

const CONTENT_TYPES = new Set<string>(Object.values(EContentType));

function ccrDir(cwd: string): string {
  return nodePath.join(cwd, '.sharkcraft', 'ccr');
}

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
export const compressCommand: ICommandHandler = {
  name: 'compress',
  description:
    'Compress a blob (file or stdin) deterministically to cut tokens — JSON→table, logs/search/diffs→signal. Reversible via `shrk expand`.',
  usage:
    'shrk [--cwd <dir>] compress [<file>|-] [--stdin] [--type <content-type>] [--query <text>] [--max <n>] [--no-cache] [--json]',
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
    if (!flagBool(args, 'no-cache')) opts.store = new FileCcrStore(ccrDir(cwd));
    const query = flagString(args, 'query');
    if (query) opts.query = query;
    const max = flagNumber(args, 'max');
    if (max !== undefined && max > 0) opts.maxItems = Math.floor(max);
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

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          contentType: result.contentType,
          strategy: result.strategy,
          lossy: result.lossy,
          tokensBefore: result.savings.before,
          tokensAfter: result.savings.after,
          tokensSaved: result.savings.saved,
          savedRatio: result.savings.ratio,
          ccrKey: result.ccrKey ?? null,
          note: result.note,
          compressed: result.compressed,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(result.compressed + '\n');
    const cached = result.ccrKey ? ` · original cached as ${result.ccrKey} (shrk expand ${result.ccrKey})` : '';
    process.stderr.write(
      `${result.strategy}: ${result.savings.before} → ${result.savings.after} tokens (−${pct}%)${cached}\n`,
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
    const store = new FileCcrStore(ccrDir(cwd));
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
    process.stdout.write(entry.content + '\n');
    return 0;
  },
};
