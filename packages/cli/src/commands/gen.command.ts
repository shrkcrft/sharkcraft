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
import * as nodePath from 'node:path';
import { asJson, header } from '../output/format-output.ts';
import { printError } from '../output/print-error.ts';
import {
  typecheckEmittedFiles,
  type IEmittedTypecheckResult,
} from '../validation/typecheck-emitted.ts';

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
    'shrk gen <templateId> [<name>] [--var key=value ...] [--dry-run] [--write] [--force] [--save-plan <file>] [--print|--show-content] [--typecheck] [--json]\n         (--typecheck compiles the emitted files against the detected tsconfig BEFORE apply — a template bug fails here, not at the human next build; --print shows the rendered bodies)',
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
    const wantTypecheck = flagBool(args, 'typecheck');
    const genOpts = {
      templateId: template.id,
      name,
      variables,
      projectRoot: inspection.projectRoot,
      overwriteStrategy: overwrite,
    };

    // --typecheck is a PRE-WRITE gate. Render a dry-run FIRST, compile the emitted
    // (full-file create) TS/TSX against the detected tsconfig in memory, and only
    // proceed to write if they compile — so an agent driving gen→apply never lands
    // non-compiling code. On failure the write is refused (nothing touches disk).
    // Only whole-file creates are checkable standalone (update ops are fragments).
    let typecheckResult: IEmittedTypecheckResult | undefined;
    let effectiveWrite = write;
    let result: ReturnType<typeof generate>;
    if (wantTypecheck) {
      const dry = generate(template, { ...genOpts, write: false });
      if (!dry.ok) {
        printError(dry.error);
        return 1;
      }
      const emitted = dry.value.plan.changes
        .filter((c) => c.type === FileChangeType.Create)
        .map((c) => ({
          absPath: nodePath.resolve(inspection.projectRoot, c.relativePath),
          contents: (c as { contents?: string }).contents ?? '',
        }))
        .filter((f) => f.contents.length > 0 && /\.tsx?$/.test(f.absPath));
      typecheckResult = typecheckEmittedFiles(inspection.projectRoot, emitted);
      // Refuse to write non-compiling output — the whole point of the gate.
      effectiveWrite = write && typecheckResult.errors.length === 0;
      result = effectiveWrite ? generate(template, { ...genOpts, write: true }) : dry;
    } else {
      result = generate(template, { ...genOpts, write });
    }

    if (!result.ok) {
      printError(result.error);
      return 1;
    }

    const { plan, summary, written } = result.value;
    const typecheckFailed = (typecheckResult?.errors.length ?? 0) > 0;
    const writeRefused = write && typecheckFailed;

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
          ...(typecheckResult ? { typecheck: typecheckResult } : {}),
          ...(writeRefused ? { writeRefused: true } : {}),
        }) + '\n',
      );
      return plan.hasConflicts || typecheckFailed ? 1 : 0;
    }

    process.stdout.write(
      header(effectiveWrite ? `Generation: ${template.id}` : `Dry-run: ${template.id}`),
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
    // --show-content: print the already-computed virtual file content so an
    // agent can review what a template would generate WITHOUT writing to disk
    // (the saved plan stays content-free). The bytes are identical in dry-run
    // and --write; this is purely additive.
    if (flagBool(args, 'show-content') || flagBool(args, 'print')) {
      process.stdout.write('\nVirtual content (not written to disk):\n');
      for (const change of plan.changes) {
        const body = (change as { contents?: string }).contents ?? '';
        process.stdout.write(`\n----- ${change.relativePath} (${change.sizeBytes} bytes) -----\n`);
        process.stdout.write(body.endsWith('\n') ? body : body + '\n');
      }
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
    if (typecheckResult) {
      if (!typecheckResult.ran) {
        process.stdout.write(`\nTypecheck: skipped — ${typecheckResult.note ?? 'nothing to check'}.\n`);
      } else if (typecheckResult.errors.length === 0) {
        process.stdout.write('\nTypecheck: ✓ emitted files compile against the detected tsconfig.\n');
      } else {
        process.stdout.write(
          `\nTypecheck: ✗ ${typecheckResult.errors.length} error(s) in the emitted files — a template bug (NOT applied):\n`,
        );
        for (const e of typecheckResult.errors.slice(0, 30)) {
          const rel = nodePath.relative(inspection.projectRoot, e.file) || e.file;
          process.stdout.write(`  ${rel}:${e.line}:${e.column}  ${e.message}\n`);
        }
        if (typecheckResult.errors.length > 30) {
          process.stdout.write(`  … (${typecheckResult.errors.length - 30} more)\n`);
        }
        if (writeRefused) {
          process.stdout.write(
            '\nWrite REFUSED — the emitted files do not typecheck (nothing written). Fix the template, then re-run.\n',
          );
        }
      }
    }
    process.stdout.write(
      `\nSummary: written=${summary.written}, skipped=${summary.skipped}, conflicts=${summary.conflicts}\n`,
    );
    if (!effectiveWrite && !savePlanPath && !writeRefused) {
      process.stdout.write('\nRe-run with --write to apply, or --save-plan <file> + `shrk apply`.\n');
    }
    return plan.hasConflicts || typecheckFailed ? 1 : 0;
  },
};
