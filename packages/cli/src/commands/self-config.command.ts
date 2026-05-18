/**
 * `shrk self-config doctor|graph|broken-links|report` — cross-reference
 * walker. Read-only; `report` writes to `.sharkcraft/reports/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildSelfConfigDoctorReport,
  buildSelfConfigDoctorReportV2,
  buildSelfConfigGraph,
  inspectSharkcraft,
  renderSelfConfigDoctorMarkdown,
  renderSelfConfigDoctorText,
  renderSelfConfigDoctorV2Markdown,
  renderSelfConfigDoctorV2Text,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const selfConfigDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Self-config cross-reference doctor — validates the graph of refs. Defaults to v2 schema; pass --schema v1 for the legacy shape.',
  usage:
    'shrk self-config doctor [--schema v1|v2] [--format text|markdown|json] [--strict]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const strict = flagBool(args, 'strict');
    const format = flagString(args, 'format') ?? 'text';
    const wantJson = flagBool(args, 'json') || format === 'json';
    const schemaArg = flagString(args, 'schema');
    const useV1 = schemaArg === 'v1';

    if (useV1) {
      const report = await buildSelfConfigDoctorReport(inspection);
      if (wantJson) {
        process.stdout.write(asJson(report) + '\n');
      } else if (format === 'markdown') {
        process.stdout.write(renderSelfConfigDoctorMarkdown(report));
      } else {
        process.stdout.write(renderSelfConfigDoctorText(report));
      }
      if (strict && (report.verdict === 'warnings' || report.verdict === 'errors')) return 1;
      return report.verdict === 'errors' ? 1 : 0;
    }

    // Default: v2 graph validation.
    const report = await buildSelfConfigDoctorReportV2(inspection);
    if (wantJson) {
      process.stdout.write(asJson(report) + '\n');
    } else if (format === 'markdown') {
      process.stdout.write(renderSelfConfigDoctorV2Markdown(report));
    } else {
      process.stdout.write(renderSelfConfigDoctorV2Text(report));
    }
    if (strict && (report.verdict === 'warnings' || report.verdict === 'errors')) return 1;
    return report.verdict === 'errors' ? 1 : 0;
  },
};

export const selfConfigGraphCommand: ICommandHandler = {
  name: 'graph',
  description: 'Render the self-config reference graph as JSON or DOT/mermaid.',
  usage: 'shrk self-config graph [--format json|mermaid|dot]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const graph = await buildSelfConfigGraph(inspection);
    const format = flagString(args, 'format') ?? 'json';
    if (format === 'mermaid') {
      const lines: string[] = ['graph TD'];
      for (const e of graph.edges) {
        lines.push(`  ${e.from.kind}_${e.from.id} --> ${e.to.kind}_${e.to.id}`);
      }
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }
    if (format === 'dot') {
      const lines: string[] = ['digraph G {'];
      for (const e of graph.edges) {
        lines.push(`  "${e.from.kind}/${e.from.id}" -> "${e.to.kind}/${e.to.id}";`);
      }
      lines.push('}');
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }
    process.stdout.write(asJson(graph) + '\n');
    return 0;
  },
};

export const selfConfigBrokenLinksCommand: ICommandHandler = {
  name: 'broken-links',
  description: 'List only the broken (unresolved) references.',
  usage: 'shrk self-config broken-links [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const graph = await buildSelfConfigGraph(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ brokenEdges: graph.brokenEdges }) + '\n');
      return graph.brokenEdges.length === 0 ? 0 : 1;
    }
    if (graph.brokenEdges.length === 0) {
      process.stdout.write('No broken references. ✓\n');
      return 0;
    }
    process.stdout.write(`=== Broken self-config references (${graph.brokenEdges.length}) ===\n`);
    for (const e of graph.brokenEdges.slice(0, 100)) {
      process.stdout.write(`  • ${e.from.kind}:${e.from.id} -> ${e.to.kind}:${e.to.id}\n`);
    }
    return 1;
  },
};

export const selfConfigReportCommand: ICommandHandler = {
  name: 'report',
  description: 'Write the self-config doctor + graph reports under .sharkcraft/reports/.',
  usage: 'shrk self-config report [--output <dir>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const schemaArg = flagString(args, 'schema');
    const useV1 = schemaArg === 'v1';
    const graph = await buildSelfConfigGraph(inspection);
    const outArg = flagString(args, 'output');
    const outDir = outArg
      ? (nodePath.isAbsolute(outArg) ? outArg : nodePath.resolve(cwd, outArg))
      : nodePath.join(cwd, '.sharkcraft', 'reports');
    mkdirSync(outDir, { recursive: true });
    const base = 'self-config-doctor';
    if (useV1) {
      const report = await buildSelfConfigDoctorReport(inspection);
      writeFileSync(nodePath.join(outDir, `${base}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');
      writeFileSync(nodePath.join(outDir, `${base}.md`), renderSelfConfigDoctorMarkdown(report), 'utf8');
      writeFileSync(
        nodePath.join(outDir, `${base}-graph.json`),
        JSON.stringify(graph, null, 2) + '\n',
        'utf8',
      );
      process.stdout.write(`Wrote ${nodePath.relative(cwd, outDir)}/${base}.{json,md} (v1) and ${base}-graph.json\n`);
      return report.verdict === 'errors' ? 1 : 0;
    }
    const report = await buildSelfConfigDoctorReportV2(inspection);
    writeFileSync(nodePath.join(outDir, `${base}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');
    writeFileSync(nodePath.join(outDir, `${base}.md`), renderSelfConfigDoctorV2Markdown(report), 'utf8');
    writeFileSync(
      nodePath.join(outDir, `${base}-graph.json`),
      JSON.stringify(graph, null, 2) + '\n',
      'utf8',
    );
    process.stdout.write(`Wrote ${nodePath.relative(cwd, outDir)}/${base}.{json,md} (v2) and ${base}-graph.json\n`);
    return report.verdict === 'errors' ? 1 : 0;
  },
};

export const selfConfigCommand: ICommandHandler = {
  name: 'self-config',
  description: 'Cross-reference doctor over SharkCraft self-config + pack contributions.',
  usage: 'shrk self-config doctor|graph|broken-links|report ...',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    args.positional = args.positional.slice(1);
    if (sub === 'doctor') return selfConfigDoctorCommand.run(args);
    if (sub === 'graph') return selfConfigGraphCommand.run(args);
    if (sub === 'broken-links') return selfConfigBrokenLinksCommand.run(args);
    if (sub === 'report') return selfConfigReportCommand.run(args);
    process.stderr.write('Usage: shrk self-config doctor|graph|broken-links|report ...\n');
    return 2;
  },
};
