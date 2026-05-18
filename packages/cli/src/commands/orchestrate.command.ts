import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildAgentOrchestrationPlan,
  inspectSharkcraft,
  OrchestrationMode,
  renderOrchestrationMarkdown,
  renderOrchestrationText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const orchestrateCommand: ICommandHandler = {
  name: 'orchestrate',
  description:
    'Produce a read-only agent orchestration plan (discovery / plan / review / apply / validate). No execution; no writes.',
  usage:
    'shrk orchestrate "<task>" [--mode conservative|balanced|aggressive] [--bundle] [--session] [--json] [--output <file.md>]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk orchestrate "<task>"\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const modeRaw = (flagString(args, 'mode') ?? '').toLowerCase();
    const mode =
      modeRaw === 'conservative'
        ? OrchestrationMode.Conservative
        : modeRaw === 'aggressive'
          ? OrchestrationMode.Aggressive
          : OrchestrationMode.Balanced;
    const riskAware = flagBool(args, 'risk-aware');
    const plan = await buildAgentOrchestrationPlan(task, inspection, { mode, riskAware });
    const output = flagString(args, 'output');
    if (flagBool(args, 'json')) {
      const body = asJson(plan) + '\n';
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
    if (output) {
      const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, renderOrchestrationMarkdown(plan), 'utf8');
      process.stdout.write(`Wrote ${abs}\n`);
      return 0;
    }
    process.stdout.write(renderOrchestrationText(plan));
    return 0;
  },
};
