import {
  buildQualityReport,
  inspectSharkcraft,
  type IQualityConfig,
  type IQualityReport,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

// `quality baseline {create|compare|update|show|diff|prune|history}`
// removed. The baseline machinery was hidden / unused; `doctor` and
// `drift` cover the actionable cases.

export const qualityCommand: ICommandHandler = {
  name: 'quality',
  description:
    'High-level quality gate: orchestrates doctor / boundaries / coverage / drift / context tests / agent tests / packs doctor. Designed to be the single command to run locally before opening a PR or in CI.',
  usage:
    'shrk [--cwd <dir>] quality [--strict] [--ci] [--min-readiness <n>] [--require-boundary-clean] [--require-drift-clean] [--require-agent-tests] [--require-context-tests] [--require-pack-signatures] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const strict = flagBool(args, 'strict');
    const ci = flagBool(args, 'ci');
    const wantJson = flagBool(args, 'json') || ci;

    const inspection = await inspectSharkcraft({
      cwd,
      ...(flagBool(args, 'require-pack-signatures') ? { verifyPackSignatures: true } : {}),
    });
    const cfgGates: IQualityConfig =
      (inspection.config as Record<string, unknown> | null)?.qualityGates as IQualityConfig | undefined ?? {};
    const config: IQualityConfig = {
      ...cfgGates,
      ...(flagNumber(args, 'min-readiness') !== undefined
        ? { minReadiness: flagNumber(args, 'min-readiness')! }
        : {}),
      ...(flagBool(args, 'require-boundary-clean') ? { requireBoundaryClean: true } : {}),
      ...(flagBool(args, 'require-drift-clean') ? { requireDriftClean: true } : {}),
      ...(flagBool(args, 'require-agent-tests') ? { requireAgentTests: true } : {}),
      ...(flagBool(args, 'require-context-tests') ? { requireContextTests: true } : {}),
      ...(flagBool(args, 'require-pack-signatures') ? { requirePackSignatures: true } : {}),
    };

    const report = await buildQualityReport({ inspection, config, strict });

    if (wantJson) {
      process.stdout.write(asJson(report) + '\n');
      return report.overall === 'fail' ? 1 : 0;
    }

    process.stdout.write(header('SharkCraft quality gate'));
    process.stdout.write(kv('overall', report.overall) + '\n');
    process.stdout.write(kv('score', `${report.score}%`) + '\n');
    process.stdout.write(kv('blockers', String(report.blockers)) + '\n');
    process.stdout.write(kv('warnings', String(report.warnings)) + '\n\n');
    for (const g of report.gates) {
      const tag = !g.executed
        ? 'SKIP '
        : g.passed
          ? 'OK   '
          : g.blocking
            ? 'BLOCK'
            : 'WARN ';
      process.stdout.write(`  ${tag}  ${g.label}\n`);
      for (const n of g.notes) process.stdout.write(`         ↳ ${n}\n`);
    }
    if (report.drift && (report.drift.counts.error > 0 || report.drift.counts.warning > 0)) {
      process.stdout.write('\nDrift summary:\n');
      process.stdout.write(
        `  errors=${report.drift.counts.error}  warnings=${report.drift.counts.warning}  info=${report.drift.counts.info}\n`,
      );
      for (const f of report.drift.findings.slice(0, 5)) {
        process.stdout.write(`  • ${f.severity}: ${f.category} — ${f.message}\n`);
      }
    }
    if (report.nextRecommendations.length > 0) {
      process.stdout.write('\nRecommendations:\n');
      for (const r of report.nextRecommendations) process.stdout.write(`  • ${r}\n`);
    }
    process.stdout.write(`\nVerdict: ${report.overall.toUpperCase()}\n`);
    return report.overall === 'fail' ? 1 : 0;
  },
};

export type { IQualityReport };
