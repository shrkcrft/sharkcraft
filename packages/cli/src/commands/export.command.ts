import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import {
  ALL_EXPORT_FORMATS,
  isExportFormat,
  renderExport,
} from '../export/export-formats.ts';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import {
  exportBundleCommand,
  exportSessionCommand,
  exportQualityCommand,
  exportReviewCommand,
} from './export-bundle.command.ts';

const ARCHIVE_SUBCOMMANDS: Record<string, ICommandHandler> = {
  bundle: exportBundleCommand,
  session: exportSessionCommand,
  quality: exportQualityCommand,
  review: exportReviewCommand,
};

export const exportCommand: ICommandHandler = {
  name: 'export',
  description:
    'Render SharkCraft knowledge as a flat agent-rule file (AGENTS.md / CLAUDE.md / .cursor/rules / copilot-instructions). Dry-run by default; pass --write to save.',
  usage:
    'shrk [--cwd <dir>] export <format> [--write] [--output <path>] [--task "<task>"] [--max-rules N] [--max-paths N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const format = args.positional[0];
    if (!format) {
      process.stderr.write(`Usage: shrk export <format>\nFormats: ${ALL_EXPORT_FORMATS.join(', ')}\n`);
      return 2;
    }
    // Archive subcommands intercepted here so `shrk export bundle <id>` still works.
    const archive = ARCHIVE_SUBCOMMANDS[format];
    if (archive) {
      const sub: ParsedArgs = { ...args, positional: args.positional.slice(1) };
      return archive.run(sub);
    }
    if (!isExportFormat(format)) {
      process.stderr.write(
        `Unknown export format "${format}".\nFormats: ${ALL_EXPORT_FORMATS.join(', ')}, bundle, session, quality, review\n`,
      );
      return 2;
    }

    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const result = renderExport(inspection, {
      format,
      task: flagString(args, 'task'),
      maxRules: flagNumber(args, 'max-rules'),
      maxPaths: flagNumber(args, 'max-paths'),
    });

    const wantJson = flagBool(args, 'json');
    const doWrite = flagBool(args, 'write');
    const outputFlag = flagString(args, 'output');
    const outputPath = outputFlag
      ? (outputFlag.startsWith('/') ? outputFlag : join(cwd, outputFlag))
      : join(cwd, result.suggestedPath);

    if (doWrite) {
      mkdirSync(dirname(outputPath), { recursive: true });
      if (existsSync(outputPath) && !flagBool(args, 'force')) {
        process.stderr.write(
          `Refusing to overwrite existing ${outputPath}. Pass --force to allow.\n`,
        );
        return 1;
      }
      writeFileSync(outputPath, result.content, 'utf8');
      if (wantJson) {
        process.stdout.write(
          asJson({ written: true, path: outputPath, format }) + '\n',
        );
      } else {
        process.stdout.write(`Wrote ${outputPath}\n`);
      }
      return 0;
    }

    if (wantJson) {
      process.stdout.write(
        asJson({
          format,
          suggestedPath: result.suggestedPath,
          targetPath: outputPath,
          content: result.content,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`Export (${format}) — dry-run`));
    process.stdout.write(`Would write to: ${outputPath}\n`);
    process.stdout.write(`Suggested default path: ${result.suggestedPath}\n\n`);
    process.stdout.write('--- preview ---\n');
    process.stdout.write(result.content);
    if (!result.content.endsWith('\n')) process.stdout.write('\n');
    process.stdout.write('--- end preview ---\n');
    process.stdout.write('\nRe-run with --write to save.\n');
    return 0;
  },
};
