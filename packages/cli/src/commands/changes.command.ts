/**
 * `shrk changes <verb>`.
 *
 * Generic changed-work summary. Reuses the existing `getChangedFiles`
 * helper + `buildChangesSummary`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildAcceptanceReplay,
  buildChangesSummary,
  inspectSharkcraft,
  renderAcceptanceReplayMarkdown,
  renderAcceptanceReplayText,
  renderChangesSummaryMarkdown,
  ReplayProfile,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

async function runChangesSummary(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const since = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const files = flagList(args, 'files');
  // Optional round / label propagated into the report.
  const roundLabel = flagString(args, 'round') ?? flagString(args, 'label');
  const opts: {
    since?: string;
    staged?: boolean;
    files?: readonly string[];
    roundLabel?: string;
  } = {};
  if (since) opts.since = since;
  if (staged) opts.staged = true;
  if (files.length > 0) opts.files = files;
  if (roundLabel) opts.roundLabel = roundLabel;
  const report = await buildChangesSummary(inspection, opts);
  const format = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text');
  const output = flagString(args, 'output');
  if (format === 'json') {
    const payload = asJson(report) + '\n';
    if (output) writeOutputFile(cwd, output, payload);
    else process.stdout.write(payload);
    return 0;
  }
  if (format === 'markdown' || format === 'md') {
    const md = renderChangesSummaryMarkdown(report);
    if (output) writeOutputFile(cwd, output, md);
    else process.stdout.write(md);
    return 0;
  }
  // text
  process.stdout.write(
    header(
      `Changes summary (${report.source}${report.ref ? ' ' + report.ref : ''}${report.roundLabel ? ` round=${report.roundLabel}` : ''})`,
    ),
  );
  process.stdout.write(`  total files: ${report.totalFiles}\n`);
  process.stdout.write(`  risk:        ${report.risk}\n`);
  for (const r of report.riskReasons) process.stdout.write(`     · ${r}\n`);
  process.stdout.write('\nFiles by area:\n');
  for (const [area, list] of Object.entries(report.filesByArea)) {
    process.stdout.write(`  ${area.padEnd(20)} (${list.length})\n`);
  }
  if (report.touchedMcpTools.length > 0) {
    process.stdout.write('\nMCP tools touched (verify read-only invariant):\n');
    for (const m of report.touchedMcpTools) process.stdout.write(`  • ${m}\n`);
  }
  process.stdout.write('\nSuggested validation:\n');
  for (const c of report.suggestedValidationCommands) process.stdout.write(`  $ ${c}\n`);
  process.stdout.write(`\nLikely PR summary: ${report.likelyPrSummary}\n`);
  return 0;
}

function writeOutputFile(cwd: string, file: string, body: string): void {
  const abs = nodePath.isAbsolute(file) ? file : nodePath.join(cwd, file);
  const dir = nodePath.dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body, 'utf8');
  process.stdout.write(`Wrote ${abs}\n`);
}

async function runChangesAcceptanceReplay(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const since = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const files = flagList(args, 'files');
  const roundLabel = flagString(args, 'round') ?? flagString(args, 'label');
  const profileRaw = flagString(args, 'profile') ?? 'changed-only';
  const profile: ReplayProfile = ((): ReplayProfile => {
    switch (profileRaw) {
      case 'standard':
        return ReplayProfile.Standard;
      case 'strict':
        return ReplayProfile.Strict;
      case 'changed-only':
      default:
        return ReplayProfile.ChangedOnly;
    }
  })();
  const summaryOpts: { since?: string; staged?: boolean; files?: readonly string[]; roundLabel?: string } = {};
  if (since) summaryOpts.since = since;
  if (staged) summaryOpts.staged = true;
  if (files.length > 0) summaryOpts.files = files;
  if (roundLabel) summaryOpts.roundLabel = roundLabel;
  const summary = await buildChangesSummary(inspection, summaryOpts);
  const replay = buildAcceptanceReplay({
    summary,
    profile,
    ...(roundLabel ? { roundLabel } : {}),
  });
  const format = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text');
  const output = flagString(args, 'output');
  if (format === 'json') {
    const payload = asJson(replay) + '\n';
    if (output) writeOutputFile(cwd, output, payload);
    else process.stdout.write(payload);
    return 0;
  }
  if (format === 'markdown' || format === 'md') {
    const md = renderAcceptanceReplayMarkdown(replay);
    if (output) writeOutputFile(cwd, output, md);
    else process.stdout.write(md);
    return 0;
  }
  const text = renderAcceptanceReplayText(replay);
  if (output) writeOutputFile(cwd, output, text);
  else process.stdout.write(text);
  return 0;
}

export const changesCommand: ICommandHandler = {
  name: 'changes',
  description:
    'Changes summary — grouped diff over --since/--staged/--files. Supports --round label and `changes acceptance-replay`. Read-only.',
  usage:
    'shrk changes <summary|impact|report|acceptance-replay> [--since <ref>] [--staged] [--files a,b,c] [--round <name>] [--profile changed-only|standard|strict] [--format text|markdown|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const sliced: ParsedArgs = { ...args, positional: args.positional.slice(1) };
    if (sub === 'summary' || sub === undefined) return runChangesSummary(sliced.positional.length > 0 ? sliced : args);
    if (sub === 'report') return runChangesSummary(sliced);
    if (sub === 'impact') return runChangesSummary(sliced);
    if (sub === 'acceptance-replay' || sub === 'replay' || sub === 'acceptance') {
      return runChangesAcceptanceReplay(sliced);
    }
    process.stderr.write(
      'Usage: shrk changes <summary|impact|report|acceptance-replay> [--since <ref>] [--staged] [--files a,b,c] [--round <name>]\n',
    );
    return 2;
  },
};
