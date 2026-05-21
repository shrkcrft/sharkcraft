import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  emitKnowledgeTs,
  importAgentsMd,
  importClaudeMd,
  importCursorRules,
  synthesizePopulatedFromImport,
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
import { asJson, bullet, header, kv } from '../output/format-output.ts';

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
    'Parse existing agent rule files (AGENTS.md / CLAUDE.md / .cursor/rules) into shrk\'s structure. By default (`--write`), saves a single draft TS file under sharkcraft/imports/ for the user to adopt by hand. Pass `--populate` to route entries directly into sharkcraft/rules.ts + paths.ts + knowledge.ts (by type) with a confidence triage report — same shape as `shrk init --infer`. Both modes dry-run by default.',
  usage:
    'shrk [--cwd <dir>] import <format> [<path>] [--prefix <id>] [--tag <t>] [--scope <s>] [--output <file>] [--write] [--populate] [--force] [--json]',
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
    const populate = flagBool(args, 'populate');
    const tsSource = emitKnowledgeTs(result.entries, {
      sourceLabel: `${fmt} (${result.sourceFiles.join(', ') || path})`,
    });

    // ── `--populate` path: distribute entries into populated
    //    sharkcraft/* files (rules.ts / paths.ts / knowledge.ts) with
    //    confidence triage. Mirrors `shrk init --infer`'s contract.
    if (populate) {
      return runPopulateImport({
        cwd,
        fmt,
        path,
        result,
        write,
        force: flagBool(args, 'force'),
        wantJson: flagBool(args, 'json'),
      });
    }

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

interface IRunPopulateImportArgs {
  cwd: string;
  fmt: ImportFormat;
  path: string;
  result: IImportResult;
  write: boolean;
  force: boolean;
  wantJson: boolean;
}

/**
 * `shrk import <format> --populate` path. Routes parsed entries
 * into populated `sharkcraft/*.ts` files by KnowledgeType, with
 * confidence triage and a companion `.imported-report.md`. Same
 * shape as `shrk init --infer`.
 */
function runPopulateImport(args: IRunPopulateImportArgs): number {
  const { cwd, fmt, path, result, write, force, wantJson } = args;
  const sharkcraftDir = nodePath.join(cwd, 'sharkcraft');
  const projectName = readProjectName(cwd) ?? 'project';
  const description = `Imported from ${fmt} (${path})`;

  const populated = synthesizePopulatedFromImport(result.entries, {
    projectName,
    description,
    sourceLabel: `${fmt} (${result.sourceFiles.join(', ') || path})`,
  });

  if (wantJson) {
    process.stdout.write(
      asJson({
        format: fmt,
        source: path,
        mode: write ? 'populate' : 'populate-dry-run',
        sharkcraftDir,
        entryCount: result.entries.length,
        warnings: result.warnings,
        files: populated.files.map((f) => ({ path: f.path, kind: f.kind })),
        report: populated.report,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(header(`Import (${fmt}) — populate`));
  process.stdout.write(kv('source', path) + '\n');
  process.stdout.write(kv('files read', String(result.sourceFiles.length)) + '\n');
  process.stdout.write(kv('entries parsed', String(result.entries.length)) + '\n');
  process.stdout.write(kv('target', sharkcraftDir) + '\n');
  process.stdout.write(kv('mode', write ? 'write' : 'dry-run (preview only)') + '\n\n');

  process.stdout.write(
    `Triage: ${populated.report.adoptedHigh.length} adopted directly · ` +
      `${populated.report.adoptedMedium.length} marked for review · ` +
      `${populated.report.dropped.length} dropped (in report).\n\n`,
  );

  if (result.warnings.length > 0) {
    process.stdout.write(header('Parser warnings'));
    for (const w of result.warnings) {
      process.stdout.write(`  ${w.origin}: ${w.message}\n`);
    }
    process.stdout.write('\n');
  }

  if (!write) {
    process.stdout.write('Would write:\n');
    for (const f of populated.files) process.stdout.write(bullet(f.path) + '\n');
    process.stdout.write('\nRe-run with --write to persist.\n');
    return 0;
  }

  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of populated.files) {
    const fullPath = nodePath.join(sharkcraftDir, file.path);
    mkdirSync(nodePath.dirname(fullPath), { recursive: true });
    if (existsSync(fullPath) && !force) {
      skipped.push(file.path);
      continue;
    }
    writeFileSync(fullPath, file.content, 'utf8');
    written.push(file.path);
  }

  if (written.length) {
    process.stdout.write('Wrote:\n');
    for (const p of written) process.stdout.write(bullet(p) + '\n');
  }
  if (skipped.length) {
    process.stdout.write('\nSkipped (already exist; use --force to overwrite):\n');
    for (const p of skipped) process.stdout.write(bullet(p) + '\n');
  }

  process.stdout.write(
    `\nRead the import report: \`${nodePath.join('sharkcraft', '.imported-report.md')}\`\n` +
      `It lists what was adopted high-confidence, what's marked for your review, ` +
      `and what \`shrk import\` deliberately doesn't recover from markdown.\n`,
  );

  process.stdout.write('\nNext:\n');
  process.stdout.write(bullet('$ shrk doctor                            — verify the populated setup') + '\n');
  process.stdout.write(bullet('$ shrk brief                             — single-page brief Claude reads first') + '\n');
  process.stdout.write(
    bullet('$ shrk export claude-skill --write       — inline the rules into Claude\'s prompt') + '\n',
  );

  return 0;
}

/**
 * Best-effort read of `package.json#name` for use as `projectName`
 * in the generated config. Falls back to undefined; the synthesizer
 * uses 'project' as a default.
 */
function readProjectName(cwd: string): string | undefined {
  const pkgPath = nodePath.join(cwd, 'package.json');
  try {
    if (!existsSync(pkgPath)) return undefined;
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name ?? undefined;
  } catch {
    return undefined;
  }
}

