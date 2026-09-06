import {
  inspectSharkcraft,
  type IQualityConfig,
  type IQualityReport,
} from '@shrkcrft/inspector';
import {
  firstUnknownFlag,
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { ExitCode } from '../exit-codes.ts';
import { runQuality, type IQualityItem } from '../quality/run-quality.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { narrowToScope, prepare, resolveScope } from './gates.command.ts';

// `quality baseline {create|compare|update|show|diff|prune|history}`
// removed. The baseline machinery was hidden / unused; `doctor` and
// `drift` cover the actionable cases.

/** Flags `quality` accepts; anything else is a typo, not an opt-in. */
const QUALITY_FLAGS: ReadonlySet<string> = new Set([
  'strict',
  'ci',
  'json',
  'min-readiness',
  'require-boundary-clean',
  'require-drift-clean',
  'require-agent-tests',
  'require-context-tests',
  'require-pack-signatures',
  'changed-only',
  'since',
  'base',
  'fail-fast',
  'cwd',
  'help',
  'h',
  'no-color',
  'color',
]);

const STATUS_TAG: Readonly<Record<IQualityItem['status'], string>> = Object.freeze({
  passed: 'OK   ',
  failed: 'FAIL ',
  skipped: 'SKIP ',
  error: 'ERROR',
});

export const qualityCommand: ICommandHandler = {
  name: 'quality',
  description:
    'THE "before you push" command: runs every configured gate — doctor / readiness / boundaries / coverage / drift / context+agent tests / packs doctor AND all seven data-defined rule planes — to completion, reporting EVERY failure with the command that reproduces it. Exhaustive by default so N independent failures cost one local run instead of N CI round-trips; `--fail-fast` opts into stop-at-first.',
  usage:
    'shrk [--cwd <dir>] quality [--changed-only | --since <ref>] [--fail-fast] [--strict] [--ci] [--min-readiness <n>] [--require-boundary-clean] [--require-drift-clean] [--require-agent-tests] [--require-context-tests] [--require-pack-signatures] [--json]',
  booleanFlags: new Set([
    'strict',
    'ci',
    'json',
    'changed-only',
    'fail-fast',
    'require-boundary-clean',
    'require-drift-clean',
    'require-agent-tests',
    'require-context-tests',
    'require-pack-signatures',
  ]),
  async run(args: ParsedArgs): Promise<number> {
    // A mistyped `--changed-only` would otherwise parse as an unrelated flag,
    // run the UNSCOPED form, and exit 0 as though the scoped check had passed.
    const bad = firstUnknownFlag(args, QUALITY_FLAGS);
    if (bad !== undefined) {
      const dash = bad.length === 1 ? '-' : '--';
      process.stderr.write(
        `unknown option '${dash}${bad}' for 'shrk quality'. Run 'shrk quality --help' for valid flags.\n`,
      );
      return ExitCode.UsageError;
    }
    const cwd = resolveCwd(args);
    const strict = flagBool(args, 'strict');
    const ci = flagBool(args, 'ci');
    const wantJson = flagBool(args, 'json') || ci;
    const failFast = flagBool(args, 'fail-fast');

    const inspection = await inspectSharkcraft({
      cwd,
      ...(flagBool(args, 'require-pack-signatures') ? { verifyPackSignatures: true } : {}),
    });
    const cfgGates: IQualityConfig =
      ((inspection.config as Record<string, unknown> | null)?.qualityGates as
        | IQualityConfig
        | undefined) ?? {};
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

    // The data-defined planes come through the SAME preparation `gates check`
    // uses — a second copy of the config load + scope narrowing would
    // eventually disagree with it, and the aggregate wired into pre-push is
    // the copy nobody notices is wrong.
    const prep = await prepare(args);
    const scope = resolveScope(args, cwd);
    if (scope.error) {
      process.stderr.write(`Cannot scope to the changeset: ${scope.error}\n`);
      return ExitCode.UsageError;
    }
    const allRules = prep.ok ? prep.value.rules : [];
    const { selected } = narrowToScope(allRules, scope.files);
    const outOfScope = allRules.filter((r) => !selected.includes(r));

    const run = await runQuality({
      inspection,
      config,
      strict,
      failFast,
      cwd,
      gateRules: selected,
      excludeDirs: prep.ok ? prep.value.excludeDirs : [],
      ...(scope.files ? { changedFiles: scope.files } : {}),
      skippedByScope: outOfScope,
      ...(prep.ok ? { planeDiagnostics: prep.value.planeDiagnostics } : {}),
    });

    // 0 clean · 1 a blocking gate failed · 2 ran but proved nothing (a gate
    // errored, or a selector matched nothing). A skip nobody asked for is
    // never masked by a passing sibling.
    const exit =
      run.verdict === 'fail'
        ? ExitCode.Failure
        : run.verdict === 'not-verified'
          ? ExitCode.NotVerified
          : ExitCode.VerifiedPass;

    if (wantJson) {
      process.stdout.write(asJson({ ...run, exitCode: exit }) + '\n');
      return exit;
    }

    process.stdout.write(header('SharkCraft quality — every gate'));
    process.stdout.write(
      kv(
        'summary',
        `${run.passed} passed / ${run.failed + run.failedWarnings} failed` +
          (run.failedWarnings > 0 ? ` (${run.failed} blocking, ${run.failedWarnings} advisory)` : '') +
          ` / ${run.skipped} skipped` +
          (run.errored > 0 ? ` / ${run.errored} could not run` : ''),
      ) + '\n',
    );
    if (run.scopedFiles !== undefined) {
      process.stdout.write(kv('scope', `changed-only (${run.scopedFiles} file(s))`) + '\n');
    }
    if (run.failFast) {
      process.stdout.write(kv('mode', '--fail-fast — stopped at the first blocking failure') + '\n');
    }
    process.stdout.write('\n');

    for (const item of run.items) {
      process.stdout.write(`  ${STATUS_TAG[item.status]}  ${item.label}\n`);
      for (const n of item.notes) process.stdout.write(`         ↳ ${n}\n`);
      // Every failure carries the command that reproduces it alone — the whole
      // point of the aggregate is that the next step never needs re-derivation.
      if (item.status === 'failed' || item.status === 'error') {
        process.stdout.write(`         $ ${item.repro}\n`);
      }
    }

    if (run.diagnostics.length > 0) {
      process.stdout.write('\nDiagnostics:\n');
      for (const d of run.diagnostics) process.stdout.write(`  • ${d}\n`);
    }

    process.stdout.write(
      `\nVerdict: ${run.verdict.toUpperCase()}  (exit ${exit})\n`,
    );
    if (run.verdict === 'pass' && run.failedWarnings > 0) {
      process.stdout.write(
        `  ${run.failedWarnings} advisory gate(s) failed without blocking — re-run with --strict to make them block.\n`,
      );
    }
    if (run.verdict === 'not-verified') {
      process.stdout.write(
        '  Nothing failed, but not everything was measured — an unmeasured gate is not a pass.\n',
      );
    }
    return exit;
  },
};

export type { IQualityReport };
