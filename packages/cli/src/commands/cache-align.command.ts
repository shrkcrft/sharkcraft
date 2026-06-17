import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  alignVolatileTokens,
  restoreVolatileTokens,
  type IAlignmentMap,
} from '@shrkcrft/compress';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

function readInput(args: ParsedArgs): string {
  const positional = args.positional[0];
  const useStdin = flagBool(args, 'stdin') || positional === undefined || positional === '-';
  return useStdin ? readFileSync(0, 'utf8') : readFileSync(positional, 'utf8');
}

function loadMap(path: string | undefined): IAlignmentMap | undefined {
  if (!path || !existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as IAlignmentMap).bindings)) {
    return parsed as IAlignmentMap;
  }
  return undefined;
}

/**
 * `shrk align` — replace volatile tokens (UUIDs/JWTs/timestamps/hashes) with
 * stable placeholders so a provider KV-cache prefix stays steady across turns.
 * Aligned text → stdout; the reversible map is written to `--map <path>` (or
 * `.sharkcraft/cache-align/align.json`). Pass an existing `--map` to carry
 * ordinals forward. `shrk unalign` restores.
 */
export const alignCommand: ICommandHandler = {
  name: 'align',
  description:
    'Replace volatile tokens with stable placeholders for KV-cache prefix stability; reversible via `shrk unalign`.',
  usage: 'shrk [--cwd <dir>] align [<file>|-] [--stdin] [--map <path>] [--json]',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    let content: string;
    try {
      content = readInput(args);
    } catch (e) {
      process.stderr.write(`align: cannot read input — ${(e as Error).message}\n`);
      return 1;
    }
    const mapPath =
      flagString(args, 'map') ?? nodePath.join(cwd, '.sharkcraft', 'cache-align', 'align.json');
    const result = alignVolatileTokens(content, loadMap(mapPath));
    mkdirSync(nodePath.dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, JSON.stringify(result.map, null, 2), 'utf8');

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ aligned: result.aligned, map: result.map, replaced: result.replaced }) + '\n');
      return 0;
    }
    process.stdout.write(result.aligned + '\n');
    process.stderr.write(`aligned: ${result.replaced} token(s) replaced · map → ${mapPath}\n`);
    return 0;
  },
};

/** `shrk unalign` — the restore half: turn placeholders back into originals. */
export const unalignCommand: ICommandHandler = {
  name: 'unalign',
  description: 'Restore the original volatile tokens in aligned text using its `--map`.',
  usage: 'shrk [--cwd <dir>] unalign [<file>|-] [--stdin] --map <path>',
  run(args: ParsedArgs): number {
    const cwd = resolveCwd(args);
    const mapPath =
      flagString(args, 'map') ?? nodePath.join(cwd, '.sharkcraft', 'cache-align', 'align.json');
    const map = loadMap(mapPath);
    if (!map) {
      process.stderr.write(`unalign: no alignment map at "${mapPath}" (pass --map <path>).\n`);
      return 1;
    }
    let content: string;
    try {
      content = readInput(args);
    } catch (e) {
      process.stderr.write(`unalign: cannot read input — ${(e as Error).message}\n`);
      return 1;
    }
    process.stdout.write(restoreVolatileTokens(content, map) + '\n');
    return 0;
  },
};
