import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  inspectSharkcraft,
  renderPlanSimulationHtml,
  renderPlanSimulationMarkdown,
  renderPlanSimulationText,
  simulatePlan,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const planSimulateCommand: ICommandHandler = {
  name: 'simulate',
  description:
    'Simulate a saved generation plan (v1 or v2): virtual final content, classified operations, boundary/policy/impact/test gates, apply readiness. Read-only.',
  usage:
    'shrk plan simulate <plan.json> [--format text|markdown|html|json] [--output <file>] [--strict] [--no-boundaries] [--no-impact] [--no-tests] [--no-policies] [--no-ownership] [--include-memory] [--diff] [--max-diff-lines N]',
  async run(args: ParsedArgs): Promise<number> {
    const planPath = args.positional[0];
    if (!planPath) {
      process.stderr.write('Usage: shrk plan simulate <plan.json>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const abs = nodePath.isAbsolute(planPath) ? planPath : nodePath.resolve(cwd, planPath);

    let report;
    try {
      report = await simulatePlan(inspection, abs, {
        strict: flagBool(args, 'strict'),
        includeBoundaries: !flagBool(args, 'no-boundaries'),
        includeImpact: !flagBool(args, 'no-impact'),
        includeTests: !flagBool(args, 'no-tests'),
        includePolicies: !flagBool(args, 'no-policies'),
        includeOwnership: !flagBool(args, 'no-ownership'),
        includeMemory: flagBool(args, 'include-memory'),
        diff: flagBool(args, 'diff'),
        ...(flagNumber(args, 'max-diff-lines') !== undefined
          ? { maxDiffLines: flagNumber(args, 'max-diff-lines') as number }
          : {}),
      });
    } catch (e) {
      process.stderr.write(`Failed to simulate plan: ${(e as Error).message}\n`);
      return 1;
    }

    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson(report) + '\n';
    else if (format === 'markdown' || format === 'md') body = renderPlanSimulationMarkdown(report);
    else if (format === 'html') body = renderPlanSimulationHtml(report);
    else body = renderPlanSimulationText(report);

    const output = flagString(args, 'output');
    if (output) {
      const absOut = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
      mkdirSync(nodePath.dirname(absOut), { recursive: true });
      writeFileSync(absOut, body, 'utf8');
      process.stdout.write(`Wrote ${absOut}\n`);
      return 0;
    }
    process.stdout.write(body);
    return 0;
  },
};
