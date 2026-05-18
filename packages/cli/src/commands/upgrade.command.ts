import {
  buildUpgradeAdvice,
  inspectSharkcraft,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

export const upgradeCheckCommand: ICommandHandler = {
  name: 'check',
  description: 'Check for SharkCraft schema migrations. Read-only; never auto-migrates.',
  usage: 'shrk upgrade check [--from <ver>] [--to <ver>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildUpgradeAdvice(inspection, {
      ...(flagString(args, 'from') ? { from: flagString(args, 'from')! } : {}),
      ...(flagString(args, 'to') ? { to: flagString(args, 'to')! } : {}),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(`=== Upgrade advisor ===\n  from ${report.fromVersion}\n  to   ${report.toVersion}\n`);
    process.stdout.write('Detected schemas:\n');
    for (const [k, v] of Object.entries(report.detectedSchemas)) process.stdout.write(`  ${k.padEnd(48)} ${v}\n`);
    process.stdout.write('Findings:\n');
    for (const f of report.findings) process.stdout.write(`  [${f.severity}] ${f.id} — ${f.message}\n  → ${f.suggestedAction}\n`);
    process.stdout.write('Recommended steps:\n');
    for (const s of report.recommendedSteps) process.stdout.write(`  $ ${s}\n`);
    return 0;
  },
};

export const upgradePlanCommand: ICommandHandler = {
  name: 'plan',
  description: 'Plan a SharkCraft upgrade — alias for `upgrade check`, surfaces JSON.',
  usage: 'shrk upgrade plan [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildUpgradeAdvice(inspection);
    process.stdout.write(asJson(report) + '\n');
    return 0;
  },
};
