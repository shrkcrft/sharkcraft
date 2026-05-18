/**
 * `shrk pr <verb>`.
 *
 * Generates a deterministic PR description from `shrk changes summary` +
 * any reports present under `.sharkcraft/reports/`.
 *
 * Read-only at the inspector level. `--output <file>` writes only when the
 * developer explicitly opts in.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildPrSummary,
  inspectSharkcraft,
  type IPrSummaryOptions,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

async function runPrSummary(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const opts: IPrSummaryOptions = {};
  const since = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const files = flagList(args, 'files');
  const maxItems = flagNumber(args, 'max-items');
  if (since) opts.since = since;
  if (staged) opts.staged = true;
  if (files.length > 0) opts.files = files;
  if (typeof maxItems === 'number') opts.maxItems = maxItems;
  if (flagBool(args, 'include-raw-links')) opts.includeRawLinks = true;
  // Session / bundle artifact sources.
  const fromSession = flagString(args, 'from-session');
  if (fromSession) opts.fromSession = fromSession;
  const fromBundle = flagString(args, 'from-bundle');
  if (fromBundle) opts.fromBundle = fromBundle;
  const report = await buildPrSummary(inspection, opts);
  const format = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'markdown');
  const output = flagString(args, 'output');
  if (format === 'json') {
    const payload = asJson(report) + '\n';
    if (output) writeOutputFile(cwd, output, payload);
    else process.stdout.write(payload);
    return 0;
  }
  if (output) {
    writeOutputFile(cwd, output, report.markdown);
    return 0;
  }
  // Default human output is a compact summary (the long markdown body
  // is one flag away via --full / --verbose, or to a file via
  // --output). Keeps `shrk pr summary` under ~25 lines in the terminal.
  const wantsFull = flagBool(args, 'full') || flagBool(args, 'verbose');
  if (wantsFull || format !== 'markdown') {
    process.stdout.write(report.markdown);
    return 0;
  }
  process.stdout.write(renderPrSummaryCompact(report.markdown));
  return 0;
}

function renderPrSummaryCompact(markdown: string): string {
  // The PR body is a Markdown document; for the compact view we keep the
  // first heading + its first ~6 list items + the test-plan headline, and
  // point at the long form. This is a pure string slice — no parsing.
  const lines = markdown.split('\n');
  const out: string[] = [];
  let kept = 0;
  let inList = false;
  let listCount = 0;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inList = false;
      listCount = 0;
      out.push(line);
      kept += 1;
      if (kept > 60) break;
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      inList = true;
      listCount += 1;
      if (listCount <= 6) out.push(line);
      else if (listCount === 7) out.push('  …');
      kept += 1;
      continue;
    }
    if (line.trim().length === 0) {
      inList = false;
      out.push(line);
      kept += 1;
      continue;
    }
    if (!inList) {
      out.push(line);
      kept += 1;
    }
  }
  out.push('');
  out.push('(text mode is summary-only — pass --full / --verbose for the full PR body, --json for machine output, --output <file> to write to disk.)');
  return out.join('\n') + '\n';
}

function writeOutputFile(cwd: string, file: string, body: string): void {
  const abs = nodePath.isAbsolute(file) ? file : nodePath.join(cwd, file);
  const dir = nodePath.dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body, 'utf8');
  process.stdout.write(`Wrote ${abs}\n`);
}

export const prCommand: ICommandHandler = {
  name: 'pr',
  description:
    'PR summary / description generator. Consumes `shrk changes summary` + .sharkcraft/reports/*. Read-only by default. Write only when --output is passed.',
  usage:
    'shrk pr <summary|description> [--since <ref>|--staged|--files a,b,c] [--max-items N] [--format markdown|json] [--output <file>] [--include-raw-links]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const sliced: ParsedArgs = { ...args, positional: args.positional.slice(1) };
    if (sub === 'summary' || sub === 'description') return runPrSummary(sliced);
    if (sub === undefined) return runPrSummary(args);
    process.stderr.write('Usage: shrk pr <summary|description> [...]\n');
    return 2;
  },
};
