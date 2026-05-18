import { inspectSharkcraft } from '@shrkcrft/inspector';
import {
  buildSavedPlan,
  FileChangeType,
  generate,
  OverwriteStrategy,
  savePlanToFile,
  signPlan,
} from '@shrkcrft/generator';
import {
  flagBool,
  flagString,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { printError } from '../output/print-error.ts';

const CHANGE_LABEL: Record<FileChangeType, string> = {
  [FileChangeType.Create]: 'CREATE',
  [FileChangeType.Update]: 'UPDATE',
  [FileChangeType.Skip]: 'SKIP  ',
  [FileChangeType.Conflict]: 'CONFL ',
  [FileChangeType.Append]: 'APPEND',
  [FileChangeType.InsertAfter]: 'INSAFT',
  [FileChangeType.InsertBefore]: 'INSBEF',
  [FileChangeType.Replace]: 'REPL  ',
  [FileChangeType.Export]: 'EXPORT',
  [FileChangeType.RenameFolder]: 'RMFLDR',
  [FileChangeType.DeleteFolder]: 'DELFLD',
};

export const genCommand: ICommandHandler = {
  name: 'gen',
  description: 'Generate code from a template. Defaults to dry-run.',
  usage:
    'shrk gen <templateId> [<name>] [--var key=value ...] [--dry-run] [--write] [--force] [--save-plan <file>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const templateId = args.positional[0];
    const name = args.positional[1];
    if (!templateId) {
      process.stderr.write(
        'Usage: shrk gen <templateId> [<name>] [--var key=value ...] [--dry-run] [--write] [--save-plan <file>]\n',
      );
      return 2;
    }

    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const template = inspection.templateRegistry.get(templateId);
    if (!template) {
      process.stderr.write(`No template with id "${templateId}".\n`);
      return 1;
    }

    const write = flagBool(args, 'write');
    const force = flagBool(args, 'force');
    const overwrite = force
      ? OverwriteStrategy.Overwrite
      : (flagString(args, 'overwrite') as OverwriteStrategy | undefined) ?? OverwriteStrategy.Never;
    const variables = flagVars(args);
    const savePlanPath = flagString(args, 'save-plan');

    const result = generate(template, {
      templateId: template.id,
      name,
      variables,
      projectRoot: inspection.projectRoot,
      overwriteStrategy: overwrite,
      write,
    });

    if (!result.ok) {
      printError(result.error);
      return 1;
    }

    const { plan, summary, written } = result.value;

    // --save-plan is allowed regardless of write/dry-run, but we refuse to
    // save plans that have conflicts (since `shrk apply` would refuse them too).
    if (savePlanPath) {
      if (plan.hasConflicts) {
        process.stderr.write(
          'Refusing to save a plan with conflicts. Resolve conflicts first.\n',
        );
        return 1;
      }
      let saved = buildSavedPlan({
        templateId: template.id,
        name: name ?? undefined,
        variables,
        projectRoot: inspection.projectRoot,
        plan,
      });
      if (flagBool(args, 'sign')) {
        const signed = signPlan(saved);
        if (!signed.ok) {
          printError(signed.error);
          return 1;
        }
        saved = signed.value;
      }
      const saveResult = savePlanToFile(saved, savePlanPath);
      if (!saveResult.ok) {
        printError(saveResult.error);
        return 1;
      }
      const signedSuffix = saved.signature ? ' [signed]' : '';
      process.stdout.write(`Saved plan${signedSuffix} → ${savePlanPath}\n`);
    }

    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          plan,
          summary,
          written: written.map((w) => w.relativePath),
          savedPlanPath: savePlanPath ?? null,
        }) + '\n',
      );
      return plan.hasConflicts ? 1 : 0;
    }

    process.stdout.write(
      header(write ? `Generation: ${template.id}` : `Dry-run: ${template.id}`),
    );
    if (plan.warnings.length) {
      process.stdout.write('Warnings:\n');
      for (const w of plan.warnings) process.stdout.write(`  - ${w}\n`);
      // Best-effort hint when warnings look like missing required variables.
      const missingVarNames = plan.warnings
        .map((w) => w.match(/^(\w+):\s+Variable\s+'\w+'\s+is required/)?.[1])
        .filter((v): v is string => typeof v === 'string');
      if (missingVarNames.length > 0) {
        process.stdout.write(
          '\nSee `shrk templates vars ' + template.id + '` for required variables.\n',
        );
        const sampleVars = template.variables
          .map(
            (v) =>
              `--var ${v.name}=${v.examples?.[0] ?? v.default ?? '<value>'}`,
          )
          .join(' ');
        process.stdout.write(
          `Example:\n  $ shrk gen ${template.id} <name> ${sampleVars} --dry-run\n`,
        );
      }
      if (!plan.changes.length) return 1;
    }
    for (const change of plan.changes) {
      process.stdout.write(
        `${CHANGE_LABEL[change.type]} ${change.relativePath} (${change.sizeBytes} bytes) — ${change.reason}\n`,
      );
    }
    if (plan.postGenerationNotes.length) {
      process.stdout.write('\nPost-generation notes:\n');
      for (const note of plan.postGenerationNotes) process.stdout.write(`  • ${note}\n`);
    }
    const updateLike = plan.changes.filter(
      (c) =>
        c.type === FileChangeType.Append ||
        c.type === FileChangeType.InsertAfter ||
        c.type === FileChangeType.InsertBefore ||
        c.type === FileChangeType.Replace ||
        c.type === FileChangeType.Export,
    );
    if (updateLike.length > 0) {
      process.stdout.write(
        `\nHUMAN REVIEW REQUIRED — ${updateLike.length} update entry/entries modify existing files.\n`,
      );
    }
    process.stdout.write(
      `\nSummary: written=${summary.written}, skipped=${summary.skipped}, conflicts=${summary.conflicts}\n`,
    );
    if (!write && !savePlanPath) {
      process.stdout.write('\nRe-run with --write to apply, or --save-plan <file> + `shrk apply`.\n');
    }
    return plan.hasConflicts ? 1 : 0;
  },
};
