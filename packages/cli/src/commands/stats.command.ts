import { buildRepositoryStats } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

function humanBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MB) return (bytes / BYTES_PER_MB).toFixed(2) + ' MB';
  if (bytes >= BYTES_PER_KB) return (bytes / BYTES_PER_KB).toFixed(1) + ' KB';
  return bytes + ' B';
}

function rightPad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function leftPad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

export const statsCommand: ICommandHandler = {
  name: 'stats',
  description:
    'Repository statistics — per-language file counts, lines of code (code/comment/blank), bytes, averages, largest files.',
  usage:
    'shrk [--cwd <dir>] stats [--json] [--top <n>] [--language <id>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const topStr = flagString(args, 'top');
    const top = topStr !== undefined ? Math.max(0, Number(topStr) || 0) : undefined;
    const language = flagString(args, 'language');

    const stats = await buildRepositoryStats({
      cwd,
      ...(top !== undefined ? { maxTopFiles: top } : {}),
      ...(language ? { language } : {}),
    });

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(stats) + '\n');
      return 0;
    }

    process.stdout.write(header('Repository statistics'));
    process.stdout.write(kv('project root', stats.projectRoot) + '\n');
    process.stdout.write(kv('generated at', stats.generatedAt) + '\n');
    if (stats.truncated) {
      process.stdout.write(kv('truncated', 'yes — file cap reached, results partial') + '\n');
    }
    process.stdout.write('\n');

    const t = stats.totals;
    process.stdout.write(`Totals\n`);
    process.stdout.write(`  files:        ${t.files.toLocaleString()}\n`);
    process.stdout.write(`  bytes:        ${t.bytes.toLocaleString()} (${humanBytes(t.bytes)})\n`);
    process.stdout.write(`  total lines:  ${t.totalLines.toLocaleString()}\n`);
    process.stdout.write(`  code lines:   ${t.codeLines.toLocaleString()}\n`);
    process.stdout.write(`  comment:      ${t.commentLines.toLocaleString()}\n`);
    process.stdout.write(`  blank:        ${t.blankLines.toLocaleString()}\n`);
    process.stdout.write('\n');

    if (stats.byLanguage.length === 0) {
      process.stdout.write('No recognized source files found.\n');
      return 0;
    }

    process.stdout.write(`Per language\n`);
    const langW = 14;
    const numW = 9;
    process.stdout.write(
      '  ' +
        rightPad('language', langW) +
        leftPad('files', numW) +
        leftPad('code', numW + 1) +
        leftPad('comment', numW + 1) +
        leftPad('blank', numW + 1) +
        leftPad('bytes', numW + 3) +
        leftPad('avg/file', numW + 2) +
        '\n',
    );
    for (const l of stats.byLanguage) {
      process.stdout.write(
        '  ' +
          rightPad(l.language, langW) +
          leftPad(l.files.toLocaleString(), numW) +
          leftPad(l.codeLines.toLocaleString(), numW + 1) +
          leftPad(l.commentLines.toLocaleString(), numW + 1) +
          leftPad(l.blankLines.toLocaleString(), numW + 1) +
          leftPad(humanBytes(l.bytes), numW + 3) +
          leftPad(l.averageFileLines.toLocaleString() + ' L', numW + 2) +
          '\n',
      );
    }

    if (stats.topFiles.length > 0) {
      process.stdout.write('\nLargest files\n');
      for (const f of stats.topFiles) {
        process.stdout.write(
          `  ${rightPad(humanBytes(f.bytes), 10)} ${leftPad(f.lines.toLocaleString() + ' L', 10)}  ${f.language.padEnd(12)} ${f.path}\n`,
        );
      }
    }

    return 0;
  },
};
