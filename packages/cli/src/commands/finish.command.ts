import type { IChangedScopeOptions } from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, bullet, header, kv } from '../output/format-output.ts';
import { runFinishGates, type IFinishGate, type IFinishReport } from '../finish/run-finish.ts';

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
};

function renderText(report: IFinishReport): void {
  process.stdout.write(header('Finish — is this changeset safe to complete?'));
  process.stdout.write(
    kv('scope', `${report.scope.mode} (${report.scope.fileCount} file${report.scope.fileCount === 1 ? '' : 's'})`) +
      '\n',
  );
  for (const g of report.gates) {
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
  process.stdout.write(kv('verdict', report.verdict) + '\n\n');
  process.stdout.write(report.summary + '\n');

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
  process.stdout.write(`\nNext: ${report.nextAction}\n`);
}

export const finishCommand: ICommandHandler = {
  name: 'finish',
  description:
    'Composite "is this changeset safe to finish?" gate: EXECUTES every deterministic changed-only check inline — boundaries + import-hygiene + wiring + policy + deleted-orphans — plus an impact summary, and returns ONE pass/fail. The single trustworthy "done?" call after editing (superset of `diff-check`; honors 0-rules→skipped). Read-only.',
  usage:
    'shrk [--cwd <dir>] finish [files... | --files a.ts,b.ts | --staged | --since <ref>] [--json]',
  booleanFlags: new Set(['json', 'staged']),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const { mode, options } = resolveScope(args, cwd);
    const report = await runFinishGates({ cwd, mode, scope: options });
    if (wantJson) {
      process.stdout.write(asJson(report) + '\n');
      return report.verdict === 'fail' ? 1 : 0;
    }
    renderText(report);
    return report.verdict === 'fail' ? 1 : 0;
  },
};
