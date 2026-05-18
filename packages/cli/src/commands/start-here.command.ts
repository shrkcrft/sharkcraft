import {
  buildStartHereReport,
  renderStartHereText,
  type StartHereFlow,
} from '@shrkcrft/inspector';
import { flagBool, flagString, type ICommandHandler, type ParsedArgs } from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

const VALID_FLOWS: readonly StartHereFlow[] = [
  'onboard',
  'brief',
  'dev',
  'review',
  'governance',
  'packs',
  'release',
];

export const startHereCommand: ICommandHandler = {
  name: 'start-here',
  description:
    'Human entry point — 30-second explanation + 5 primary flows + safety pledge.',
  usage:
    'shrk start-here [--flow onboard|brief|dev|review|governance|packs|release] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const flowRaw = flagString(args, 'flow');
    let flow: StartHereFlow | null = null;
    if (flowRaw) {
      if (!(VALID_FLOWS as readonly string[]).includes(flowRaw)) {
        process.stderr.write(`Unknown --flow "${flowRaw}". Use ${VALID_FLOWS.join('|')}.\n`);
        return 2;
      }
      flow = flowRaw as StartHereFlow;
    }
    const report = buildStartHereReport(flow);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(renderStartHereText(report));
    return 0;
  },
};
