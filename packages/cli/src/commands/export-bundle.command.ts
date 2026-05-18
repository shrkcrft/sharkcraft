import * as nodePath from 'node:path';
import {
  exportDevSession,
  exportFeatureBundle,
  exportQuality,
  exportReview,
  inspectSharkcraft,
  buildQualityReport,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

function outputDir(args: ParsedArgs, cwd: string, fallback: string): string {
  return flagString(args, 'output') ?? nodePath.join(cwd, '.sharkcraft', 'exports', fallback);
}

export const exportBundleCommand: ICommandHandler = {
  name: 'bundle',
  description: 'Export a feature bundle to a folder.',
  usage: 'shrk export bundle <id> [--output <dir>]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk export bundle <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const dir = outputDir(args, cwd, `bundle-${id}`);
    const r = exportFeatureBundle(cwd, id, dir);
    if (!r) {
      process.stderr.write(`No bundle "${id}"\n`);
      return 1;
    }
    if (flagBool(args, 'json')) process.stdout.write(asJson(r) + '\n');
    else process.stdout.write(`Exported ${r.files.length} file(s) → ${r.outputDir}\n`);
    return 0;
  },
};

export const exportSessionCommand: ICommandHandler = {
  name: 'session',
  description: 'Export a dev session to a folder.',
  usage: 'shrk export session <id> [--output <dir>]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk export session <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const dir = outputDir(args, cwd, `session-${id}`);
    const r = exportDevSession(cwd, id, dir);
    if (!r) {
      process.stderr.write(`No session "${id}"\n`);
      return 1;
    }
    if (flagBool(args, 'json')) process.stdout.write(asJson(r) + '\n');
    else process.stdout.write(`Exported ${r.files.length} file(s) → ${r.outputDir}\n`);
    return 0;
  },
};

export const exportQualityCommand: ICommandHandler = {
  name: 'quality',
  description: 'Export current quality report to a folder.',
  usage: 'shrk export quality [--output <dir>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = await buildQualityReport({ inspection, config: {} });
    const dir = outputDir(args, cwd, `quality-${new Date().toISOString().slice(0, 10)}`);
    const r = exportQuality(cwd, dir, report);
    if (flagBool(args, 'json')) process.stdout.write(asJson(r) + '\n');
    else process.stdout.write(`Exported quality → ${r.outputDir}\n`);
    return 0;
  },
};

export const exportReviewCommand: ICommandHandler = {
  name: 'review',
  description: 'Export a review packet to a folder.',
  usage: 'shrk export review <packet.json> [--output <dir>]',
  async run(args: ParsedArgs): Promise<number> {
    const file = args.positional[0];
    if (!file) {
      process.stderr.write('Usage: shrk export review <packet.json>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const dir = outputDir(args, cwd, `review-${new Date().toISOString().slice(0, 10)}`);
    const r = exportReview(cwd, file, dir);
    if (!r) {
      process.stderr.write(`Packet not found: ${file}\n`);
      return 1;
    }
    if (flagBool(args, 'json')) process.stdout.write(asJson(r) + '\n');
    else process.stdout.write(`Exported review → ${r.outputDir}\n`);
    return 0;
  },
};
