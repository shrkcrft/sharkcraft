import * as nodePath from 'node:path';
import {
  buildDashboardExport,
  diffDashboardExports,
  inspectSharkcraft,
  renderDashboardExportDiffHtml,
  renderDashboardExportDiffMarkdown,
  type DashboardExportSection,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagList,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const dashboardExportCommand: ICommandHandler = {
  name: 'export',
  description:
    'Export dashboard-ready JSON files (repository-map, architecture, intelligence, packs, role-views, ...). Writes only into the supplied output dir. R20: `--compare-with <oldDir>` produces a diff.',
  usage:
    'shrk dashboard export [--output .sharkcraft/dashboard-data] [--include repository-map,architecture,...] [--compare-with <oldDir>] [--format text|markdown|html|json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const output = flagString(args, 'output') ?? '.sharkcraft/dashboard-data';
    const includeRaw = flagList(args, 'include') as DashboardExportSection[];
    const report = await buildDashboardExport(inspection, {
      outputDir: output,
      ...(includeRaw.length > 0 ? { include: includeRaw } : {}),
    });

    const compareWith = flagString(args, 'compare-with');
    if (compareWith) {
      const oldDir = nodePath.isAbsolute(compareWith) ? compareWith : nodePath.resolve(cwd, compareWith);
      const diff = diffDashboardExports(oldDir, report.outputDir);
      const format = (flagString(args, 'format') ?? '').toLowerCase();
      if (format === 'json' || flagBool(args, 'json')) {
        process.stdout.write(asJson(diff) + '\n');
        return 0;
      }
      if (format === 'html') {
        process.stdout.write(renderDashboardExportDiffHtml(diff));
        return 0;
      }
      if (format === 'markdown') {
        process.stdout.write(renderDashboardExportDiffMarkdown(diff));
        return 0;
      }
      process.stdout.write(
        `Dashboard diff: ${diff.oldDir} → ${diff.newDir}\n` +
          `  packs: ${diff.metrics.packs.old} → ${diff.metrics.packs.new}\n` +
          `  graph nodes: ${diff.metrics.graphNodes.old} → ${diff.metrics.graphNodes.new}\n` +
          `  graph edges: ${diff.metrics.graphEdges.old} → ${diff.metrics.graphEdges.new}\n` +
          `  architecture risks: ${diff.metrics.architectureRisks.old} → ${diff.metrics.architectureRisks.new}\n` +
          `  boundary violations: ${diff.metrics.boundaryViolations.old} → ${diff.metrics.boundaryViolations.new}\n`,
      );
      return 0;
    }

    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(`Wrote ${report.entries.length} dashboard data file(s) to ${report.outputDir}\n`);
    return 0;
  },
};

export const dashboardDiffCommand: ICommandHandler = {
  name: 'diff',
  description: 'Diff two dashboard exports (by directory).',
  usage: 'shrk dashboard diff <oldDir> <newDir> [--format text|markdown|html|json]',
  async run(args: ParsedArgs): Promise<number> {
    const [oldArg, newArg] = args.positional;
    if (!oldArg || !newArg) {
      process.stderr.write('Usage: shrk dashboard diff <oldDir> <newDir>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const oldAbs = nodePath.isAbsolute(oldArg) ? oldArg : nodePath.resolve(cwd, oldArg);
    const newAbs = nodePath.isAbsolute(newArg) ? newArg : nodePath.resolve(cwd, newArg);
    const diff = diffDashboardExports(oldAbs, newAbs);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    if (format === 'json' || flagBool(args, 'json')) {
      process.stdout.write(asJson(diff) + '\n');
      return 0;
    }
    if (format === 'html') {
      process.stdout.write(renderDashboardExportDiffHtml(diff));
      return 0;
    }
    if (format === 'markdown') {
      process.stdout.write(renderDashboardExportDiffMarkdown(diff));
      return 0;
    }
    process.stdout.write(
      `Dashboard diff: ${diff.oldDir} → ${diff.newDir}\n` +
        `  packs: ${diff.metrics.packs.old} → ${diff.metrics.packs.new}\n` +
        `  graph nodes: ${diff.metrics.graphNodes.old} → ${diff.metrics.graphNodes.new}\n` +
        `  graph edges: ${diff.metrics.graphEdges.old} → ${diff.metrics.graphEdges.new}\n` +
        `  architecture risks: ${diff.metrics.architectureRisks.old} → ${diff.metrics.architectureRisks.new}\n` +
        `  boundary violations: ${diff.metrics.boundaryViolations.old} → ${diff.metrics.boundaryViolations.new}\n`,
    );
    return 0;
  },
};
