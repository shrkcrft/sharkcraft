import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import {
  ALL_EXPORT_FORMATS,
  isExportFormat,
  renderExport,
} from '../export/export-formats.ts';
import { buildClaudeCommands } from '../export/claude-commands-export.ts';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, bullet, header } from '../output/format-output.ts';
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
    'Inversion — pull SharkCraft rules into the agent\'s prompt instead of the agent calling back to shrk. Single-file outputs: claude-skill (.claude/skills/<name>/SKILL.md, recommended), agents-md (AGENTS.md), claude-md (CLAUDE.md), cursor-rules (.cursor/rules/*.mdc), copilot-instructions. Multi-file output: claude-commands (.claude/commands/*.md — per-project slash commands like /new-service, /check-changes, /follow-shrk). Dry-run by default; pass --write to save.',
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
    // Multi-file `claude-commands` dispatches separately — it emits
    // one .md per slash command, not a single rendered file.
    if (format === 'claude-commands') {
      return runClaudeCommandsExport(args);
    }
    if (!isExportFormat(format)) {
      process.stderr.write(
        `Unknown export format "${format}".\nFormats: ${ALL_EXPORT_FORMATS.join(', ')}, claude-commands, bundle, session, quality, review\n`,
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

/**
 * `shrk export claude-commands` — multi-file generator for Claude
 * Code's native `.claude/commands/` slash-command primitive. Produces
 * one .md per command (static + per-template).
 *
 * Unlike single-file exports (claude-skill / claude-md / etc.) this
 * writes a SET of files. Each file is a complete recipe Claude Code
 * loads when the user types the matching slash command.
 */
async function runClaudeCommandsExport(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const result = buildClaudeCommands(inspection);
  const wantJson = flagBool(args, 'json');
  const doWrite = flagBool(args, 'write');
  const force = flagBool(args, 'force');

  if (wantJson) {
    process.stdout.write(
      asJson({
        format: 'claude-commands',
        write: doWrite,
        files: result.files.map((f) => ({
          path: f.path,
          slash: f.slash,
          source: f.source,
        })),
      }) + '\n',
    );
    return 0;
  }

  if (!doWrite) {
    process.stdout.write(header('Export (claude-commands) — dry-run'));
    process.stdout.write(`Would write ${result.files.length} command file(s):\n\n`);
    for (const f of result.files) {
      process.stdout.write(`  ${f.path}\n`);
      process.stdout.write(`    → users type \`/${f.slash}\` in Claude Code (${f.source})\n`);
    }
    process.stdout.write('\nRe-run with --write to save.\n');
    return 0;
  }

  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of result.files) {
    const fullPath = join(cwd, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    if (existsSync(fullPath) && !force) {
      skipped.push(file.path);
      continue;
    }
    writeFileSync(fullPath, file.content, 'utf8');
    written.push(file.path);
  }

  process.stdout.write(header('Claude commands exported'));
  if (written.length) {
    process.stdout.write(`Wrote ${written.length} command file(s):\n`);
    for (const p of written) {
      const f = result.files.find((x) => x.path === p)!;
      process.stdout.write(bullet(`${p}  → \`/${f.slash}\``) + '\n');
    }
  }
  if (skipped.length) {
    process.stdout.write(
      `\nSkipped ${skipped.length} (already exist; use --force to overwrite):\n`,
    );
    for (const p of skipped) process.stdout.write(bullet(p) + '\n');
  }
  process.stdout.write(
    '\nClaude Code picks up `.claude/commands/*.md` automatically. ' +
      'Open the project in Claude Code, type `/` — the slash commands are in the palette.\n',
  );
  return 0;
}
