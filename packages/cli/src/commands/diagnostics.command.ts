import { readFileSync } from 'node:fs';
import {
  buildDiagnosticByCode,
  getDiagnosticEntry,
  listDiagnostics,
  renderDiagnosticText,
  suggestDiagnostic,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const diagnosticsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List known SharkCraft failure diagnostics. Read-only.',
  usage: 'shrk diagnostics list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const entries = listDiagnostics();
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ schema: 'sharkcraft.diagnostic-registry/v1', entries }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Diagnostics (${entries.length})`));
    for (const e of entries) {
      const keys = e.contextKeys.length === 0 ? '' : ` context: ${e.contextKeys.join(', ')}`;
      process.stdout.write(`  ${e.code.padEnd(34)} ${e.description}${keys}\n`);
    }
    return 0;
  },
};

export const diagnosticsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Look up a SharkCraft failure diagnostic by code. Read-only.',
  usage: 'shrk diagnostics get <code> [--ctx key=value ...] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const code = args.positional[0];
    if (!code) {
      process.stderr.write('Usage: shrk diagnostics get <code> [--ctx key=value ...]\n');
      return 2;
    }
    const entry = getDiagnosticEntry(code);
    if (!entry) {
      process.stderr.write(`Unknown diagnostic code "${code}". Try \`shrk diagnostics list\`.\n`);
      return 2;
    }
    const ctx: Record<string, unknown> = {};
    for (const raw of flagList(args, 'ctx')) {
      const i = raw.indexOf('=');
      if (i < 0) continue;
      const key = raw.slice(0, i).trim();
      const value = raw.slice(i + 1);
      ctx[key] = value;
    }
    const diagnostic = buildDiagnosticByCode(entry.code, ctx);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(diagnostic) + '\n');
      return 0;
    }
    process.stdout.write(renderDiagnosticText(diagnostic));
    return 0;
  },
};

export const diagnosticsSuggestCommand: ICommandHandler = {
  name: 'suggest',
  description: 'Suggest the most likely diagnostic for a stderr blob. Read-only.',
  usage: 'shrk diagnostics suggest "<error text>" | --from-file <file> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const fromFile = flagString(args, 'from-file');
    let input = args.positional.join(' ').trim();
    if (fromFile) {
      try {
        input = readFileSync(fromFile, 'utf8');
      } catch (err) {
        process.stderr.write(`Failed to read --from-file: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    if (!input) {
      process.stderr.write('Usage: shrk diagnostics suggest "<error text>" or --from-file <file>\n');
      return 2;
    }
    const r = suggestDiagnostic(input);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(r) + '\n');
      return 0;
    }
    if (!r.topSuggestion) {
      process.stdout.write('No matching diagnostic found.\n');
      return 1;
    }
    process.stdout.write(`Top suggestion: ${r.topSuggestion.code} (${r.topSuggestion.confidence})\n`);
    process.stdout.write(`  title: ${r.topSuggestion.title}\n`);
    process.stdout.write(`  next:  ${r.topSuggestion.nextCommand}\n`);
    if (r.topSuggestion.docsLink) process.stdout.write(`  docs:  ${r.topSuggestion.docsLink}\n`);
    if (r.candidates.length > 1) {
      process.stdout.write('Other candidates:\n');
      for (const c of r.candidates.slice(1)) process.stdout.write(`  ${c.code} (${c.confidence})\n`);
    }
    return 0;
  },
};
