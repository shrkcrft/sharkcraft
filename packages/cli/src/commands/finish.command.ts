import type { IChangedScopeOptions } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, bullet, header, kv } from '../output/format-output.ts';
import {
  runFinishGates,
  type IFinishGate,
  type IFinishReport,
} from '../finish/run-finish.ts';
import { ExitCode } from '../exit-codes.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { verdictLine } from '../gates/verdict-line.ts';

type FinishMode = 'worktree' | 'staged' | 'since' | 'files';

function resolveScope(args: ParsedArgs, cwd: string): {
  mode: FinishMode;
  options: IChangedScopeOptions;
} {
  const staged = flagBool(args, 'staged');
  const since = flagString(args, 'since');
  const filesRaw = flagString(args, 'files');
  const files = filesRaw
    ? filesRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : args.positional.filter((s) => s.length > 0);
  if (files.length > 0) return { mode: 'files', options: { projectRoot: cwd, files } };
  if (staged) return { mode: 'staged', options: { projectRoot: cwd, staged: true } };
  if (since) return { mode: 'since', options: { projectRoot: cwd, since } };
  return { mode: 'worktree', options: { projectRoot: cwd, includeWorktree: true } };
}

const STATUS_GLYPH: Readonly<Record<IFinishGate['status'], string>> = {
  pass: '✓',
  fail: '✗',
  skipped: '–',
  // A pass over part of its scope is not a pass (round 11).
  partial: '~',
};

function renderText(report: IFinishReport): void {
  process.stdout.write(header('Finish — is this changeset safe to complete?'));
  process.stdout.write(
    kv('scope', `${report.scope.mode} (${report.scope.fileCount} file${report.scope.fileCount === 1 ? '' : 's'})`) +
      '\n',
  );
  for (const g of report.gates) {
    // The status is settled once in runFinishGates (`partial` for a pass over
    // part of its scope), so this line and --json say the same word.
    process.stdout.write(`  ${STATUS_GLYPH[g.status]} ${g.name.padEnd(11)} ${g.status.padEnd(8)} ${g.detail}\n`);
  }
  if (report.impact.ran) {
    process.stdout.write(
      kv('impact', `risk=${report.impact.risk}, ${report.impact.directDependents} direct / ${report.impact.transitiveDependents} transitive dependents`) +
        '\n',
    );
  } else if (report.impact.note) {
    process.stdout.write(kv('impact', `(skipped — ${report.impact.note})`) + '\n');
  }
  process.stdout.write(kv('verdict', `${report.verdict} (exit ${report.exit})`) + '\n');
  if (report.exit === ExitCode.Failure) process.stdout.write(`\n${report.summary}\n`);

  const failing = report.gates.filter((g) => g.status === 'fail');
  for (const g of failing) {
    process.stdout.write(`\n${g.name} — failing items:\n`);
    for (const item of g.items.slice(0, 15)) {
      const loc = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '';
      process.stdout.write(bullet(`${loc ? loc + ' — ' : ''}${item.message}`) + '\n');
    }
    if (g.items.length > 15) {
      process.stdout.write(`  … and ${g.items.length - 15} more (pass --json for the full list).\n`);
    }
  }
  // The final line comes from the SETTLED envelope: the "Safe to finish ✓"
  // sentence exists only at exit 0; at 2 the summary leads a NOT VERIFIED line
  // naming every sub-gate that fell short.
  const line = verdictLine(
    report.gate,
    `${report.summary} ✓`,
    report.exit === ExitCode.NotVerified ? report.summary : undefined,
  );
  if (line) process.stdout.write(`\n${line}\n`);
  if (report.exit === ExitCode.NotVerified && report.gate.coverage.expected === 0) {
    process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty changeset explicitly.\n`);
  }
  process.stdout.write(`\nNext: ${report.nextAction}\n`);
}

export const finishCommand: ICommandHandler = {
  name: 'finish',
  description:
    'Composite "is this changeset safe to finish?" gate: EXECUTES every deterministic changed-only check inline — boundaries (with rule-edit escalation) + import-hygiene + wiring + unprovided (DI graph) + policy + deleted-orphans + arch (advisory cycles) — over tracked AND untracked changes, and returns ONE honest 0/1/2 verdict (0 pass · 1 fail · 2 not-verified — "evaluated nothing" and "passed over part of its scope" are 2, never a green 0). The single trustworthy "done?" call after editing (superset of `diff-check`). --json carries the shared gate envelope. Read-only.',
  usage:
    'shrk [--cwd <dir>] finish [files... | --files a.ts,b.ts | --staged | --since <ref>] [--allow-empty] [--json]',
  // `--allow-empty` is the shared verdict valve — declared boolean so it can
  // never swallow a following positional file.
  booleanFlags: new Set(['json', 'staged', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const { mode, options } = resolveScope(args, cwd);
    const report = await runFinishGates({
      cwd,
      mode,
      scope: options,
      emptyValve: (expected) => allowEmptyValve(args, expected),
    });
    if (wantJson) {
      process.stdout.write(asJson({ ...report, exitCode: report.exit }) + '\n');
      return report.exit;
    }
    renderText(report);
    return report.exit;
  },
};
