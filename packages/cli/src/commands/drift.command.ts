import {
  buildDriftReport,
  classifyChangedScope,
  classifyRuleDrift,
  inspectSharkcraft,
  resolveChangedFiles,
  RuleEnforcementState,
  summariseChangedScope,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

// `drift baseline {create|compare|update}` removed.
// The baseline machinery was hidden / unused; `drift rules` and the
// core `drift` report cover the actionable cases.

export const driftCommand: ICommandHandler = {
  name: 'drift',
  description:
    'Detect architecture drift: boundary violations, broken preset references, pipeline/template links, missing pack assets. Also: `shrk drift rules` — classify each rule as ENFORCED/PARTIAL/MANUAL/ASPIRATIONAL/STALE.',
  usage:
    'shrk [--cwd <dir>] drift [--skip-boundaries] [--json] | shrk drift rules [--strict] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    if (args.positional[0] === 'rules') {
      const sub: ParsedArgs = { ...args, positional: args.positional.slice(1) };
      return runDriftRules(sub);
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildDriftReport(inspection, {
      runBoundaries: !flagBool(args, 'skip-boundaries'),
    });
    const changedOnly = flagBool(args, 'changed-only');
    const since = flagString(args, 'since');
    const staged = flagBool(args, 'staged');
    const files = flagList(args, 'files');
    const changedScopeOpts: IChangedScopeOptions | null =
      changedOnly || since || staged || files.length > 0
        ? {
            projectRoot: cwd,
            ...(since ? { since } : {}),
            ...(staged ? { staged: true } : {}),
            ...(files.length > 0 ? { files } : {}),
            includeWorktree: changedOnly || !since,
          }
        : null;
    const classification = changedScopeOpts
      ? (() => {
          const resolved = resolveChangedFiles(changedScopeOpts);
          return classifyChangedScope({
            projectRoot: cwd,
            current: report.findings.map((f) => {
              const file = (f.evidence as { file?: string } | undefined)?.file;
              return {
                key: `${f.category}:${f.message}:${file ?? ''}`,
                code: f.category,
                severity: f.severity,
                message: f.message,
                ...(file ? { file } : {}),
              };
            }),
            changedFiles: resolved.files,
          });
        })()
      : null;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({ ...report, ...(classification ? { changedScope: classification } : {}) }) + '\n',
      );
      return report.counts.error > 0 ? 1 : 0;
    }
    process.stdout.write(header('Drift report'));
    process.stdout.write(
      kv(
        'totals',
        `${report.counts.error} errors, ${report.counts.warning} warnings, ${report.counts.info} info`,
      ) + '\n\n',
    );
    if (classification) {
      process.stdout.write(`changed-scope: ${summariseChangedScope(classification)}\n\n`);
    }
    if (report.findings.length === 0) {
      process.stdout.write('No drift detected.\n');
      return 0;
    }
    for (const f of report.findings) {
      const tag = f.severity.toUpperCase().padEnd(8);
      process.stdout.write(`  ${tag} ${f.category.padEnd(22)} ${f.message}\n`);
      if (f.suggestedFix) process.stdout.write(`           ↳ ${f.suggestedFix}\n`);
    }
    return report.counts.error > 0 ? 1 : 0;
  },
};

/**
 * `shrk drift rules`. Classifies every rule into ENFORCED /
 * PARTIALLY_ENFORCED / MANUAL_ONLY / ASPIRATIONAL / STALE / UNKNOWN so a
 * maintainer can see whether the rule system is real or ceremonial.
 *
 * `--strict` fails when ASPIRATIONAL or STALE rules exist.
 * `--json` emits the structured report.
 */
async function runDriftRules(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const report = classifyRuleDrift(inspection);
  const strict = flagBool(args, 'strict');
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(report) + '\n');
    return strict &&
      (report.summary[RuleEnforcementState.Aspirational] > 0 ||
        report.summary[RuleEnforcementState.Stale] > 0)
      ? 1
      : 0;
  }
  process.stdout.write(header('Rule enforcement drift'));
  process.stdout.write(
    kv(
      'totals',
      Object.entries(report.summary)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}: ${n}`)
        .join(', ') || 'no rules',
    ) + '\n\n',
  );
  if (report.entries.length === 0) {
    process.stdout.write('No rules registered.\n');
    return 0;
  }
  for (const e of report.entries) {
    const tag = e.state.toUpperCase().padEnd(20);
    const src = e.source.type === 'pack' ? `[${e.source.packageName ?? 'pack'}]` : '[local]';
    process.stdout.write(`  ${tag} ${e.id.padEnd(36)} ${src} — ${e.reason}\n`);
  }
  if (report.nextCommands.length > 0) {
    process.stdout.write('\nNext:\n');
    for (const c of report.nextCommands) process.stdout.write(`  ${c}\n`);
  }
  if (strict) {
    const failing =
      report.summary[RuleEnforcementState.Aspirational] +
      report.summary[RuleEnforcementState.Stale];
    if (failing > 0) {
      process.stdout.write(`\nStrict mode: failing because ${failing} rule(s) are aspirational or stale.\n`);
      return 1;
    }
  }
  return 0;
}
