/**
 * `shrk audit project-coupling`.
 *
 * The project-coupling audit is the load-bearing surface from the old
 * `migrate` namespace; the rest of `migrate` was speculative and removed.
 *
 * Read-only:
 *   - `audit`  prints to stdout
 *   - `plan`   prints a structured plan to stdout
 *   - `report` writes report files under `.sharkcraft/reports/`
 *
 * Never edits source.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  auditProjectCoupling,
  renderProjectCouplingAuditMarkdown,
  renderProjectCouplingAuditText,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

function parseTokens(args: ParsedArgs): string[] {
  return flagList(args, 'token');
}

type FailOn = 'engine' | 'any' | 'never';

/**
 * Exit-code logic is category-specific.
 *
 * `--fail-on engine` exits non-zero iff at least one hit is classified as
 * `engine` (the file lives in engine source: `packages/`, `apps/`, `libs/`).
 * Pack-target hits in localConfig and other categories no longer leak into
 * the engine exit.
 *
 * `--fail-on any` exits non-zero iff there is any non-noise hit (anything
 * outside fixture-only / docs-example / false-positive).
 *
 * `--fail-on never` always exits 0.
 */
function exitCodeForFailOn(
  failOn: FailOn,
  report: {
    verdict: 'clean' | 'has-coupling';
    hits: readonly { risk: string; externalizationTarget: string }[];
  },
): number {
  if (failOn === 'never') return 0;
  if (failOn === 'engine') {
    return report.hits.some((h) => h.externalizationTarget === 'engine') ? 1 : 0;
  }
  const anyReal = report.hits.some(
    (h) =>
      h.externalizationTarget !== 'false-positive' &&
      h.externalizationTarget !== 'fixture-only' &&
      h.externalizationTarget !== 'docs-example',
  );
  return anyReal ? 1 : 0;
}

function describeFailOn(
  failOn: FailOn,
  report: {
    hits: readonly { externalizationTarget: string }[];
  },
): string {
  if (failOn === 'never') return 'fail-on=never → exit always 0.';
  if (failOn === 'engine') {
    const engineHits = report.hits.filter((h) => h.externalizationTarget === 'engine').length;
    return `fail-on=engine → exit non-zero iff engine-category hits > 0 (current: ${engineHits}).`;
  }
  const real = report.hits.filter(
    (h) =>
      h.externalizationTarget !== 'false-positive' &&
      h.externalizationTarget !== 'fixture-only' &&
      h.externalizationTarget !== 'docs-example',
  ).length;
  return `fail-on=any → exit non-zero iff non-noise hits > 0 (current: ${real}).`;
}

async function runAudit(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const tokens = parseTokens(args);
  if (tokens.length === 0) {
    process.stderr.write(
      'Usage: shrk audit project-coupling audit --token <pat> [--token <pat> ...] [--fail-on engine|any|never] [--word-boundary|--no-word-boundary] [--format text|markdown|json] [--output <file>]\n',
    );
    return 2;
  }
  const wordBoundary = !flagBool(args, 'no-word-boundary');
  const failOnArg = (flagString(args, 'fail-on') ?? 'engine').toLowerCase() as FailOn;
  const failOn: FailOn =
    failOnArg === 'any' || failOnArg === 'never' || failOnArg === 'engine'
      ? failOnArg
      : 'engine';
  const report = auditProjectCoupling({ projectRoot: cwd, tokens, wordBoundary });
  const format = flagString(args, 'format') ?? 'text';
  const output = flagString(args, 'output');
  if (output) {
    const absOut = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
    mkdirSync(nodePath.dirname(absOut), { recursive: true });
    if (absOut.endsWith('.json'))
      writeFileSync(absOut, JSON.stringify(report, null, 2) + '\n', 'utf8');
    else if (absOut.endsWith('.md'))
      writeFileSync(absOut, renderProjectCouplingAuditMarkdown(report), 'utf8');
    else writeFileSync(absOut, renderProjectCouplingAuditText(report), 'utf8');
  }
  if (flagBool(args, 'json') || format === 'json') {
    process.stdout.write(asJson(report) + '\n');
    return exitCodeForFailOn(failOn, report);
  }
  if (format === 'markdown') {
    process.stdout.write(renderProjectCouplingAuditMarkdown(report));
    process.stdout.write(`\n_${describeFailOn(failOn, report)}_\n`);
    return exitCodeForFailOn(failOn, report);
  }
  process.stdout.write(renderProjectCouplingAuditText(report));
  process.stdout.write(`  ${describeFailOn(failOn, report)}\n`);
  return exitCodeForFailOn(failOn, report);
}

async function runPlan(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const tokens = parseTokens(args);
  if (tokens.length === 0) {
    process.stderr.write('Usage: shrk audit project-coupling plan --token <pat> ...\n');
    return 2;
  }
  const wordBoundary = !flagBool(args, 'no-word-boundary');
  const report = auditProjectCoupling({ projectRoot: cwd, tokens, wordBoundary });
  process.stdout.write(renderProjectCouplingAuditMarkdown(report));
  return 0;
}

async function runReport(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const tokens = parseTokens(args);
  if (tokens.length === 0) {
    process.stderr.write('Usage: shrk audit project-coupling report --token <pat> ...\n');
    return 2;
  }
  const wordBoundary = !flagBool(args, 'no-word-boundary');
  const report = auditProjectCoupling({ projectRoot: cwd, tokens, wordBoundary });
  const outDir = nodePath.join(cwd, '.sharkcraft', 'reports');
  mkdirSync(outDir, { recursive: true });
  const base = `project-coupling-audit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(
    nodePath.join(outDir, `${base}.json`),
    JSON.stringify(report, null, 2) + '\n',
    'utf8',
  );
  writeFileSync(
    nodePath.join(outDir, `${base}.md`),
    renderProjectCouplingAuditMarkdown(report),
    'utf8',
  );
  process.stdout.write(`Wrote .sharkcraft/reports/${base}.{json,md}\n`);
  return report.verdict === 'clean' ? 0 : 1;
}

export const auditProjectCouplingCommand: ICommandHandler = {
  name: 'project-coupling',
  description:
    'Audit / plan / report project-specific coupling. Pass --token to scan for identifiers; the engine ships zero built-in tokens.',
  usage:
    'shrk audit project-coupling <audit|plan|report> --token <pat> [...]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    args.positional = args.positional.slice(1);
    if (sub === 'audit') return runAudit(args);
    if (sub === 'plan') return runPlan(args);
    if (sub === 'report') return runReport(args);
    process.stderr.write(
      'Usage: shrk audit project-coupling <audit|plan|report> --token <pat>\n',
    );
    return 2;
  },
};
