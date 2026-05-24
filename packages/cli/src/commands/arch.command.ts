import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  ArchReportStore,
  diffSnapshots,
  runArchCheck,
  type IArchContract,
  type IArchReport,
} from '@shrkcrft/architecture-guard';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { safeImport } from '@shrkcrft/core';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * `shrk arch` — semantic architecture checks on top of the code graph.
 * Sub-verbs:
 *   - shrk arch check               run all enabled checks (auto-loads sharkcraft/arch.ts)
 *   - shrk arch check --contract X  point at an explicit contract file
 */
export const archCommand: ICommandHandler = {
  name: 'arch',
  description:
    'Architecture-guard checks: public-API misuse, barrel risks, cycle severity, project-specific contracts (sharkcraft/arch.ts auto-loaded). `shrk arch baseline <write|show|clear>` to gate doctor on a frozen baseline.',
  usage:
    'shrk arch check [--contract <path>] [--no-cycles] [--no-barrels] [--no-public-api] [--no-persist] [--json]\n         shrk arch baseline <write|show|clear> [--contract <path>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'baseline') {
      return runArchBaseline({
        ...args,
        positional: args.positional.slice(1),
      });
    }
    if (sub !== 'check') {
      process.stderr.write(this.usage + '\n');
      return 2;
    }
    return runArchCheckCommand(args);
  },
};

async function runArchCheckCommand(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const noCycles = flagBool(args, 'no-cycles');
  const noBarrels = flagBool(args, 'no-barrels');
  const noPublicApi = flagBool(args, 'no-public-api');
  const noPersist = flagBool(args, 'no-persist');
  const contractPath = flagString(args, 'contract');
  const contract = await loadContract(cwd, contractPath);
  const report = runArchCheck({
    projectRoot: cwd,
    ...(contract ? { contract } : {}),
    enable: {
      publicApi: !noPublicApi,
      barrels: !noBarrels,
      cycles: !noCycles,
      contract: !!contract,
    },
  });
  // Persist a compact snapshot so `shrk doctor` can compare against
  // baseline without re-running the full check. `--no-persist` opts out
  // (useful when scripting against many trees).
  if (!noPersist) {
    try {
      new ArchReportStore(cwd).writeLast(report);
    } catch {
      // best-effort
    }
  }
  if (wantJson) {
    process.stdout.write(asJson(report) + '\n');
    return report.countsBySeverity.error > 0 ? 1 : 0;
  }
  printArchReport(report);
  return report.countsBySeverity.error > 0 ? 1 : 0;
}

async function runArchBaseline(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const verb = args.positional[0] ?? 'show';
  const store = new ArchReportStore(cwd);
  const wantJson = flagBool(args, 'json');
  if (verb === 'write') {
    const contractPath = flagString(args, 'contract');
    const contract = await loadContract(cwd, contractPath);
    const report = runArchCheck({
      projectRoot: cwd,
      ...(contract ? { contract } : {}),
    });
    const snap = store.writeBaseline(report);
    // Update last.json too so doctor's first delta read is meaningful.
    store.writeLast(report);
    if (wantJson) {
      process.stdout.write(asJson({ wrote: store.baselinePath, baseline: snap }) + '\n');
      return 0;
    }
    process.stdout.write(`Architecture baseline written → ${store.baselinePath}\n`);
    process.stdout.write(
      `  ${snap.violationIds.length} violations (` +
        `${snap.countsBySeverity.error} error, ` +
        `${snap.countsBySeverity.warning} warning, ` +
        `${snap.countsBySeverity.info} info) ` +
        `across ${snap.filesAnalyzed} files.\n`,
    );
    return 0;
  }
  if (verb === 'show') {
    const baseline = store.readBaseline();
    if (!baseline) {
      const msg = `No baseline at ${store.baselinePath}. Run \`shrk arch baseline write\` to freeze one.\n`;
      if (wantJson) {
        process.stdout.write(asJson({ baseline: null, path: store.baselinePath }) + '\n');
        return 1;
      }
      process.stdout.write(msg);
      return 1;
    }
    if (wantJson) {
      process.stdout.write(asJson({ path: store.baselinePath, baseline }) + '\n');
      return 0;
    }
    process.stdout.write(header('Architecture baseline'));
    process.stdout.write(kv('path', store.baselinePath) + '\n');
    process.stdout.write(kv('generated at', baseline.generatedAt) + '\n');
    process.stdout.write(kv('files analyzed', String(baseline.filesAnalyzed)) + '\n');
    process.stdout.write(
      kv(
        'counts',
        `${baseline.countsBySeverity.error} error, ${baseline.countsBySeverity.warning} warning, ${baseline.countsBySeverity.info} info`,
      ) + '\n',
    );
    const last = store.readLast();
    if (last) {
      const delta = diffSnapshots(baseline, last);
      process.stdout.write(
        '\nDelta (last − baseline): ' +
          `${delta.newViolationIds.length} new, ${delta.fixedViolationIds.length} fixed ` +
          `(error ${delta.errorDelta >= 0 ? '+' : ''}${delta.errorDelta}, warning ${delta.warningDelta >= 0 ? '+' : ''}${delta.warningDelta})\n`,
      );
    } else {
      process.stdout.write('\n(no `last.json` yet — run `shrk arch check`.)\n');
    }
    return 0;
  }
  if (verb === 'clear') {
    const removed = store.clearBaseline();
    if (wantJson) {
      process.stdout.write(asJson({ removed, path: store.baselinePath }) + '\n');
      return 0;
    }
    process.stdout.write(
      removed ? `Baseline removed: ${store.baselinePath}\n` : 'No baseline to remove.\n',
    );
    return 0;
  }
  process.stderr.write('Usage: shrk arch baseline <write|show|clear> [--json]\n');
  return 2;
}

function printArchReport(report: IArchReport): void {
  process.stdout.write(header('Architecture guard'));
  process.stdout.write(kv('schema', report.schema) + '\n');
  process.stdout.write(kv('files analyzed', String(report.filesAnalyzed)) + '\n');
  process.stdout.write(kv('errors', String(report.countsBySeverity.error)) + '\n');
  process.stdout.write(kv('warnings', String(report.countsBySeverity.warning)) + '\n');
  if (report.violations.length === 0) {
    process.stdout.write('\nNo violations.\n');
  } else {
    process.stdout.write('\nViolations:\n');
    for (const v of report.violations.slice(0, 80)) {
      const lineSuffix = v.line ? `:${v.line}` : '';
      process.stdout.write(`  [${v.severity}] [${v.kind}] ${v.file}${lineSuffix}\n    ${v.message}\n`);
      if (v.suggestedFix) process.stdout.write(`    → ${v.suggestedFix}\n`);
    }
    if (report.violations.length > 80) {
      process.stdout.write(`  … (${report.violations.length - 80} more)\n`);
    }
  }
  for (const d of report.diagnostics.slice(0, 5)) process.stdout.write(`! ${d}\n`);
}

async function loadContract(
  cwd: string,
  explicit: string | undefined,
): Promise<IArchContract | undefined> {
  const candidate = explicit
    ? nodePath.isAbsolute(explicit) ? explicit : nodePath.resolve(cwd, explicit)
    : nodePath.join(cwd, 'sharkcraft', 'arch.ts');
  if (!existsSync(candidate)) {
    if (explicit) process.stderr.write(`! contract file not found: ${candidate}\n`);
    return undefined;
  }
  const result = await safeImport(candidate);
  if (!result.ok) {
    process.stderr.write(`! failed to load arch contract: ${result.error.message}\n`);
    return undefined;
  }
  const mod = result.module;
  const exported = (mod as { default?: IArchContract; contract?: IArchContract }).default ??
    (mod as { contract?: IArchContract }).contract;
  if (!exported) {
    process.stderr.write(`! arch contract module ${candidate} does not export a contract\n`);
    return undefined;
  }
  return exported;
}
