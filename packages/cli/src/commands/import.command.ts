import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  emitKnowledgeTs,
  importAgentsMd,
  importClaudeMd,
  importCursorRules,
  type IImportResult,
} from '@shrkcrft/importer';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

function repeatedFlagList(args: ParsedArgs, name: string): string[] {
  return flagList(args, name, { dedupe: true });
}

type ImportFormat = 'agents-md' | 'claude-md' | 'cursor-rules';
const KNOWN_FORMATS: ImportFormat[] = ['agents-md', 'claude-md', 'cursor-rules'];

function defaultSource(format: ImportFormat): string {
  switch (format) {
    case 'agents-md':
      return 'AGENTS.md';
    case 'claude-md':
      return 'CLAUDE.md';
    case 'cursor-rules':
      return '.cursor/rules';
  }
}

function defaultOutput(format: ImportFormat): string {
  return `sharkcraft/imports/${format}-import.draft.ts`;
}

export const importCommand: ICommandHandler = {
  name: 'import',
  description:
    'Parse existing agent rule files (AGENTS.md / CLAUDE.md / .cursor/rules) into a structured @shrkcrft/knowledge TypeScript draft. Dry-run by default; --write saves the draft to sharkcraft/imports/.',
  usage:
    'shrk [--cwd <dir>] import <format> [<path>] [--prefix <id>] [--tag <t>] [--scope <s>] [--output <file>] [--write] [--force] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const format = args.positional[0];
    if (!format || !KNOWN_FORMATS.includes(format as ImportFormat)) {
      process.stderr.write(
        `Usage: shrk import <format> [<path>]\nFormats: ${KNOWN_FORMATS.join(', ')}\n`,
      );
      return 2;
    }
    const fmt = format as ImportFormat;
    const cwd = resolveCwd(args);
    const path = args.positional[1] ?? defaultSource(fmt);
    const prefix = flagString(args, 'prefix');
    const extraTags = repeatedFlagList(args, 'tag');
    const scope = repeatedFlagList(args, 'scope');

    const base = {
      filePath: path,
      projectRoot: cwd,
      ...(prefix !== undefined ? { idPrefix: prefix } : {}),
      ...(extraTags.length ? { extraTags } : {}),
      ...(scope.length ? { scope } : {}),
    };
    let result: IImportResult;
    switch (fmt) {
      case 'agents-md':
        result = importAgentsMd(base);
        break;
      case 'claude-md':
        result = importClaudeMd(base);
        break;
      case 'cursor-rules':
        result = importCursorRules(base);
        break;
    }

    const outPath = nodePath.resolve(
      cwd,
      flagString(args, 'output') ?? flagString(args, 'out') ?? defaultOutput(fmt),
    );
    const write = flagBool(args, 'write');
    const tsSource = emitKnowledgeTs(result.entries, {
      sourceLabel: `${fmt} (${result.sourceFiles.join(', ') || path})`,
    });

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          format: fmt,
          source: path,
          out: outPath,
          write,
          entryCount: result.entries.length,
          warnings: result.warnings,
          entries: result.entries.map(({ content: _, ...meta }) => meta),
        }) + '\n',
      );
      return result.entries.length === 0 ? 1 : 0;
    }

    process.stdout.write(header(`Import (${fmt})`));
    process.stdout.write(kv('source', path) + '\n');
    process.stdout.write(kv('files read', String(result.sourceFiles.length)) + '\n');
    process.stdout.write(kv('entries parsed', String(result.entries.length)) + '\n');
    if (prefix) process.stdout.write(kv('id prefix', prefix) + '\n');
    if (extraTags.length) process.stdout.write(kv('extra tags', extraTags.join(', ')) + '\n');
    if (scope.length) process.stdout.write(kv('scope', scope.join(', ')) + '\n');
    process.stdout.write(kv('output', outPath) + '\n');
    process.stdout.write(kv('mode', write ? 'write' : 'dry-run (preview only)') + '\n\n');

    if (result.warnings.length > 0) {
      process.stdout.write(header('Warnings'));
      for (const w of result.warnings) {
        process.stdout.write(`  ${w.origin}: ${w.message}\n`);
      }
      process.stdout.write('\n');
    }

    if (result.entries.length === 0) {
      process.stderr.write('No entries parsed.\n');
      return 1;
    }

    if (!write) {
      process.stdout.write(header('Preview (first 30 lines of generated TS)'));
      const preview = tsSource.split('\n').slice(0, 30).join('\n');
      process.stdout.write(preview + '\n');
      process.stdout.write(
        `\n--- (preview truncated; total ${tsSource.split('\n').length} lines) ---\n`,
      );
      process.stdout.write('\nRe-run with --write to persist.\n');
      return 0;
    }

    mkdirSync(nodePath.dirname(outPath), { recursive: true });
    if (existsSync(outPath) && !flagBool(args, 'force')) {
      process.stderr.write(
        `Refusing to overwrite ${outPath}. Pass --force or pick a different --out.\n`,
      );
      return 1;
    }
    writeFileSync(outPath, tsSource, 'utf8');
    process.stdout.write(`Wrote ${outPath}\n`);
    return 0;
  },
};
