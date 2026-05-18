import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  inspectSharkcraft,
  lintTemplates,
  testTemplates,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const templatesLintCommand: ICommandHandler = {
  name: 'lint',
  description:
    'Lint registered templates (titles, vars, target safety, placeholders). --fix-preview emits a TODO patch per finding under .sharkcraft/fixes/templates-lint/ (preview only — never mutates source).',
  usage: 'shrk templates lint [<id>] [--fix-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const ids = args.positional.length > 0 ? args.positional : undefined;
    const report = lintTemplates(inspection, ids);
    const fixPreview = flagBool(args, 'fix-preview');
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      if (fixPreview) writeFixPreviewPatches(cwd, report.results);
      return report.summary.errors > 0 ? 1 : 0;
    }
    process.stdout.write(header(`Template lint`));
    for (const r of report.results) {
      const tag = r.passed ? 'OK' : 'FAIL';
      process.stdout.write(`  ${tag} ${r.templateId} (${r.issues.length} issues)\n`);
      for (const i of r.issues) process.stdout.write(`    [${i.severity}] ${i.code}: ${i.message}\n`);
    }
    if (fixPreview) {
      const wrote = writeFixPreviewPatches(cwd, report.results);
      if (wrote > 0) {
        process.stdout.write(
          `\nWrote ${wrote} fix-preview patch(es) under .sharkcraft/fixes/templates-lint/\n`,
        );
      } else {
        process.stdout.write('\nNo fix-preview patches needed.\n');
      }
    }
    return report.summary.errors > 0 ? 1 : 0;
  },
};

interface ILintResult {
  templateId: string;
  passed: boolean;
  issues: ReadonlyArray<{ severity: string; code: string; message: string }>;
}

/** Write a per-template TODO patch under `.sharkcraft/fixes/templates-lint/`. */
function writeFixPreviewPatches(
  cwd: string,
  results: ReadonlyArray<ILintResult>,
): number {
  const dir = nodePath.join(cwd, '.sharkcraft', 'fixes', 'templates-lint');
  let wrote = 0;
  for (const r of results) {
    if (r.passed || r.issues.length === 0) continue;
    mkdirSync(dir, { recursive: true });
    const safeId = r.templateId.replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
    const patchPath = nodePath.join(dir, `${safeId}.patch.md`);
    const body = renderLintPatch(r);
    writeFileSync(patchPath, body, 'utf8');
    wrote += 1;
  }
  return wrote;
}

function renderLintPatch(r: ILintResult): string {
  const lines: string[] = [];
  lines.push(`# Template lint fix preview: ${r.templateId}`);
  lines.push('');
  lines.push('Preview-only — this file documents the issues found and the smallest');
  lines.push('change you can apply. SharkCraft never mutates source automatically.');
  lines.push('');
  lines.push('## Issues');
  for (const i of r.issues) {
    lines.push(`- [${i.severity}] **${i.code}** — ${i.message}`);
  }
  lines.push('');
  lines.push('## Suggested actions');
  lines.push('');
  lines.push('1. Update the template definition (id / title / variables / files).');
  lines.push('2. Validate:');
  lines.push('   - `shrk templates lint`');
  lines.push('   - `shrk templates drift --min-severity warning`');
  lines.push('   - `shrk self-config doctor`');
  lines.push('3. If this is a pack-contributed template, also run:');
  lines.push('   - `shrk packs signature-status`');
  lines.push('   - `shrk packs sign --if-needed`');
  lines.push('');
  return lines.join('\n') + '\n';
}

export const templatesTestCommand: ICommandHandler = {
  name: 'test',
  description: 'Render each template against example variables.',
  usage: 'shrk templates test [<id>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const ids = args.positional.length > 0 ? args.positional : undefined;
    const results = testTemplates(inspection, ids);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(results) + '\n');
      return results.every((r) => r.passed) ? 0 : 1;
    }
    for (const r of results) {
      process.stdout.write(`  ${r.passed ? 'OK' : 'FAIL'} ${r.templateId} renders=${r.renderedChanges} conflicts=${r.conflicts}\n`);
      for (const e of r.errors) process.stdout.write(`    ! ${e}\n`);
    }
    return results.every((r) => r.passed) ? 0 : 1;
  },
};

export const templatesSnapshotCommand: ICommandHandler = {
  name: 'snapshot',
  description: 'Print the rendered output of a template.',
  usage: 'shrk templates snapshot <id>',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk templates snapshot <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const tpl = inspection.templateRegistry.get(id);
    if (!tpl) {
      process.stderr.write(`Unknown template: ${id}\n`);
      return 1;
    }
    const results = testTemplates(inspection, [id]);
    if (flagBool(args, 'json')) process.stdout.write(asJson(results[0]) + '\n');
    else process.stdout.write(`${id}: renders=${results[0]?.renderedChanges} conflicts=${results[0]?.conflicts}\n`);
    void flagString;
    return 0;
  },
};
