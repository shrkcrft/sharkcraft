import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  inspectSharkcraft,
  OrchestrationMode,
  renderWorkflowSimulationText,
  simulateWorkflow,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

const VALID_SIMULATION_MODES: readonly string[] = ['conservative', 'balanced', 'aggressive'];

export const simulateCommand: ICommandHandler = {
  name: 'simulate',
  description:
    'Predict what a workflow would do without executing anything. Read-only. Optionally takes a playbook or pipeline id.',
  usage:
    'shrk simulate "<task>" [--playbook <id>] [--pipeline <id>] [--mode conservative|balanced|aggressive] [--json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk simulate "<task>"\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const playbookId = flagString(args, 'playbook');
    const pipelineId = flagString(args, 'pipeline');
    const modeRaw = (flagString(args, 'mode') ?? '').toLowerCase();
    // Warn on a typo'd --mode rather than silently treating it as balanced.
    if (modeRaw && !VALID_SIMULATION_MODES.includes(modeRaw)) {
      process.stderr.write(
        `Unknown --mode ${modeRaw}. Valid: ${VALID_SIMULATION_MODES.join(', ')} (defaulting to balanced).\n`,
      );
    }
    const mode =
      modeRaw === 'conservative'
        ? OrchestrationMode.Conservative
        : modeRaw === 'aggressive'
          ? OrchestrationMode.Aggressive
          : OrchestrationMode.Balanced;
    const sim = await simulateWorkflow(task, inspection, {
      ...(playbookId ? { playbookId } : {}),
      ...(pipelineId ? { pipelineId } : {}),
      mode,
    });
    const output = flagString(args, 'output');
    if (flagBool(args, 'json')) {
      const body = asJson(sim) + '\n';
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
      writeFileSync(abs, renderWorkflowSimulationText(sim), 'utf8');
      process.stdout.write(`Wrote ${abs}\n`);
      return 0;
    }
    process.stdout.write(renderWorkflowSimulationText(sim));
    return 0;
  },
};
