import * as nodePath from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildRepositoryMemory,
  diffMemoryIndex,
  inspectSharkcraft,
  latestMemorySnapshot,
  listMemorySnapshots,
  loadMemorySnapshot,
  loadRepositoryMemory,
  memoryRiskForTask,
  renderMemoryDiffMarkdown,
  renderMemoryDiffText,
  renderMemoryReportText,
  renderMemoryRiskText,
  resetRepositoryMemory,
  saveRepositoryMemory,
  writeMemorySnapshot,
  type IRepositoryMemoryIndex,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

function writeOutOrJson(args: ParsedArgs, cwd: string, body: string): number {
  const output = flagString(args, 'output');
  if (output) {
    const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    process.stdout.write(`Wrote ${abs}\n`);
    return 0;
  }
  process.stdout.write(body);
  return 0;
}

export const memoryBuildCommand: ICommandHandler = {
  name: 'build',
  description:
    'Build (or refresh) the local repository memory index from .sharkcraft history. Writes only to .sharkcraft/memory/. With --write-snapshot, also archives the index to .sharkcraft/memory/history/. Local-only.',
  usage: 'shrk memory build [--write-snapshot] [--json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const index = await buildRepositoryMemory(inspection);
    const file = saveRepositoryMemory(inspection.projectRoot, index);
    let snapshotFile: string | undefined;
    if (flagBool(args, 'write-snapshot')) {
      snapshotFile = writeMemorySnapshot(inspection.projectRoot, index);
    }
    if (flagBool(args, 'json')) {
      return writeOutOrJson(args, cwd, asJson({ index, indexFile: file, snapshotFile }) + '\n');
    }
    process.stdout.write(`Memory index written to ${file}\n`);
    if (snapshotFile) process.stdout.write(`Snapshot archived: ${snapshotFile}\n`);
    process.stdout.write(`  sources scanned: ${index.sourceCount}\n`);
    process.stdout.write(`  top files     : ${index.files.length}\n`);
    process.stdout.write(`  diagnostics   : ${index.diagnostics.length}\n`);
    process.stdout.write(`  release blockers: ${index.releaseBlockers.length}\n`);
    return 0;
  },
};

function loadIndexFromPath(file: string): IRepositoryMemoryIndex | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IRepositoryMemoryIndex;
  } catch {
    return null;
  }
}

export const memoryDiffCommand: ICommandHandler = {
  name: 'diff',
  description:
    'Compare two memory snapshots (or one snapshot + the current index). Read-only.',
  usage: 'shrk memory diff <old.json> [new.json] [--format text|markdown|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const oldArg = args.positional[0];
    const newArg = args.positional[1];
    if (!oldArg) {
      process.stderr.write('Usage: shrk memory diff <old.json> [new.json]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const oldPath = nodePath.isAbsolute(oldArg) ? oldArg : nodePath.resolve(cwd, oldArg);
    const before = loadIndexFromPath(oldPath);
    if (!before) {
      process.stderr.write(`Cannot read ${oldPath}\n`);
      return 1;
    }
    let after: IRepositoryMemoryIndex | null;
    if (newArg) {
      const newPath = nodePath.isAbsolute(newArg) ? newArg : nodePath.resolve(cwd, newArg);
      after = loadIndexFromPath(newPath);
      if (!after) {
        process.stderr.write(`Cannot read ${newPath}\n`);
        return 1;
      }
    } else {
      after = loadRepositoryMemory(cwd);
      if (!after) {
        process.stderr.write('No current memory index. Run `shrk memory build` first.\n');
        return 1;
      }
    }
    const diff = diffMemoryIndex(before, after);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson(diff) + '\n';
    else if (format === 'markdown' || format === 'md') body = renderMemoryDiffMarkdown(diff);
    else body = renderMemoryDiffText(diff);
    return writeOutOrJson(args, cwd, body);
  },
};

export const memoryDriftCommand: ICommandHandler = {
  name: 'drift',
  description:
    'Compare the current memory index against the latest snapshot under .sharkcraft/memory/history/. Read-only.',
  usage: 'shrk memory drift [--previous <snapshot.json>] [--format text|markdown|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const current = loadRepositoryMemory(cwd);
    if (!current) {
      process.stderr.write('No current memory index. Run `shrk memory build` first.\n');
      return 1;
    }
    const previousFlag = flagString(args, 'previous');
    let before: IRepositoryMemoryIndex | null;
    if (previousFlag) {
      const p = nodePath.isAbsolute(previousFlag) ? previousFlag : nodePath.resolve(cwd, previousFlag);
      before = loadMemorySnapshot(p);
      if (!before) {
        process.stderr.write(`Cannot read ${p}\n`);
        return 1;
      }
    } else {
      before = latestMemorySnapshot(cwd);
    }
    const diff = diffMemoryIndex(before, current);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson(diff) + '\n';
    else if (format === 'markdown' || format === 'md') body = renderMemoryDiffMarkdown(diff);
    else body = renderMemoryDiffText(diff);
    return writeOutOrJson(args, cwd, body);
  },
};

export const memorySnapshotsCommand: ICommandHandler = {
  name: 'snapshots',
  description: 'List archived memory snapshots under .sharkcraft/memory/history/. Read-only.',
  usage: 'shrk memory snapshots [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const list = listMemorySnapshots(cwd);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(list) + '\n');
      return 0;
    }
    if (list.length === 0) {
      process.stdout.write('No snapshots yet. Run `shrk memory build --write-snapshot`.\n');
      return 0;
    }
    for (const f of list) process.stdout.write(`${f}\n`);
    return 0;
  },
};

export const memoryReportCommand: ICommandHandler = {
  name: 'report',
  description: 'Render a human-readable repository memory report. Read-only.',
  usage: 'shrk memory report [--json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const index = loadRepositoryMemory(cwd);
    if (!index) {
      process.stderr.write(
        'No memory index found. Run `shrk memory build` first.\n',
      );
      return 1;
    }
    if (flagBool(args, 'json')) {
      return writeOutOrJson(args, cwd, asJson(index) + '\n');
    }
    return writeOutOrJson(args, cwd, renderMemoryReportText(index));
  },
};

export const memoryRiskCommand: ICommandHandler = {
  name: 'risk',
  description:
    'Combine task risk with historical signals from .sharkcraft/memory/index.json. Read-only.',
  usage: 'shrk memory risk "<task>" [--json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk memory risk "<task>"\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const index = loadRepositoryMemory(cwd);
    const report = memoryRiskForTask(index, task);
    if (flagBool(args, 'json')) {
      return writeOutOrJson(args, cwd, asJson(report) + '\n');
    }
    return writeOutOrJson(args, cwd, renderMemoryRiskText(report));
  },
};

export const memoryFilesCommand: ICommandHandler = {
  name: 'files',
  description: 'List historically risky files from the memory index. Read-only.',
  usage: 'shrk memory files [--json] [--limit <n>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const index = loadRepositoryMemory(cwd);
    if (!index) {
      process.stderr.write('No memory index found. Run `shrk memory build` first.\n');
      return 1;
    }
    const limitRaw = flagString(args, 'limit');
    const limit = limitRaw ? Number(limitRaw) : 30;
    const top = index.files.slice(0, Number.isFinite(limit) ? limit : 30);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(top) + '\n');
      return 0;
    }
    for (const f of top) {
      process.stdout.write(
        `${String(f.touchCount).padStart(4)}x ${f.path} (conflicts=${f.conflictCount}, warnings=${f.warningCount})\n`,
      );
    }
    return 0;
  },
};

export const memoryDiagnosticsCommand: ICommandHandler = {
  name: 'diagnostics',
  description: 'List recurring diagnostics from the memory index. Read-only.',
  usage: 'shrk memory diagnostics [--json] [--limit <n>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const index = loadRepositoryMemory(cwd);
    if (!index) {
      process.stderr.write('No memory index found. Run `shrk memory build` first.\n');
      return 1;
    }
    const limitRaw = flagString(args, 'limit');
    const limit = limitRaw ? Number(limitRaw) : 30;
    const top = index.diagnostics.slice(0, Number.isFinite(limit) ? limit : 30);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(top) + '\n');
      return 0;
    }
    for (const d of top) {
      process.stdout.write(`${String(d.count).padStart(3)}x ${d.code}\n`);
    }
    return 0;
  },
};

export const memoryResetCommand: ICommandHandler = {
  name: 'reset',
  description:
    'Reset the local repository memory. Default is --dry-run; pass --write to actually delete .sharkcraft/memory.',
  usage: 'shrk memory reset [--dry-run|--write]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const writeMode = flagBool(args, 'write');
    const result = resetRepositoryMemory(cwd, { dryRun: !writeMode });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(result) + '\n');
      return 0;
    }
    if (result.notRemoved.length && !writeMode) {
      // not removed because dir didn't exist
    }
    if (result.dryRun) {
      process.stdout.write(`(dry-run) Would remove: ${result.removed.join(', ') || '(nothing)'}\n`);
      process.stdout.write('Pass --write to actually delete.\n');
    } else {
      process.stdout.write(`Removed: ${result.removed.join(', ') || '(nothing)'}\n`);
    }
    return 0;
  },
};
