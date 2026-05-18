/**
 * `shrk registrations` subcommands.
 *
 * Pack-driven registration hints describe downstream registration steps that
 * generated constructs typically need (e.g. composer wiring, route entries).
 * The engine never auto-applies a hint; the human applies after preview.
 *
 *   shrk registrations list      [--source local|pack] [--json]
 *   shrk registrations get <id>  [--json]
 *   shrk registrations doctor    [--json]
 *   shrk registrations preview <id> [--var key=value ...] [--json]
 */
import * as nodePath from 'node:path';
import {
  inspectSharkcraft,
  listRegistrationHints,
  listRegistrationHintIssues,
  getRegistrationHint,
  previewRegistrationHint,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { savePlanToFile, signPlan, type ISavedPlan } from '@shrkcrft/generator';

const REGISTRATION_HINT_SYNTHETIC_TEMPLATE = '__registration-hint__';

const registrationsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List registered registration hints (local + pack).',
  usage: 'shrk registrations list [--source local|pack] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const source = flagString(args, 'source');
    const all = await listRegistrationHints(inspection);
    const filtered = source ? all.filter((e) => e.source === source) : all;
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(filtered) + '\n');
      return 0;
    }
    process.stdout.write(header(`Registration hints (${filtered.length})`));
    for (const e of filtered) {
      process.stdout.write(
        `  • ${e.hint.id.padEnd(36)} ${e.hint.title}${
          e.source === 'pack' && e.packageName ? `  [pack:${e.packageName}]` : ''
        }\n`,
      );
    }
    if (filtered.length === 0) {
      process.stdout.write(
        '  (no registration hints contributed — packs add them via registrationHintFiles[])\n',
      );
    }
    return 0;
  },
};

const registrationsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show a registration hint by id.',
  usage: 'shrk registrations get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk registrations get <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const entry = await getRegistrationHint(inspection, id);
    if (!entry) {
      process.stderr.write(`Registration hint "${id}" not found.\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entry) + '\n');
      return 0;
    }
    process.stdout.write(header(`Registration hint: ${entry.hint.id}`));
    process.stdout.write(`  title         ${entry.hint.title}\n`);
    if (entry.hint.description) process.stdout.write(`  description   ${entry.hint.description}\n`);
    process.stdout.write(`  source        ${entry.source}${entry.packageName ? ` (${entry.packageName})` : ''}\n`);
    if (entry.hint.discovery.targetFile) {
      process.stdout.write(`  target file   ${entry.hint.discovery.targetFile}\n`);
    }
    if (entry.hint.discovery.targetGlobs && entry.hint.discovery.targetGlobs.length > 0) {
      process.stdout.write(`  target globs  ${entry.hint.discovery.targetGlobs.join(', ')}\n`);
    }
    if (entry.hint.requiresHumanReview) {
      process.stdout.write(`  ⚠ requires human review\n`);
    }
    process.stdout.write('\nOperations:\n');
    for (const op of entry.hint.operations) {
      process.stdout.write(`  • ${op.kind}${op.anchor ? `  anchor="${op.anchor}"` : ''}\n`);
    }
    if (entry.hint.validationCommands && entry.hint.validationCommands.length > 0) {
      process.stdout.write('\nValidation commands:\n');
      for (const c of entry.hint.validationCommands) process.stdout.write(`  $ ${c}\n`);
    }
    return 0;
  },
};

const registrationsDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description: 'Validate registration hint registries (local + pack).',
  usage: 'shrk registrations doctor [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const issues = await listRegistrationHintIssues(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ issues }) + '\n');
      return issues.some((i) => i.severity === 'error') ? 1 : 0;
    }
    process.stdout.write(header(`Registration hint doctor (${issues.length} issue(s))`));
    if (issues.length === 0) {
      process.stdout.write('  OK\n');
      return 0;
    }
    for (const i of issues) {
      process.stdout.write(
        `  ${i.severity.toUpperCase().padEnd(7)} ${i.code.padEnd(28)} ${i.message}\n`,
      );
    }
    return issues.some((i) => i.severity === 'error') ? 1 : 0;
  },
};

const registrationsPreviewCommand: ICommandHandler = {
  name: 'preview',
  description:
    'Preview a registration hint against the live file system. Read-only — no edits are made.',
  usage: 'shrk registrations preview <id> [--var key=value ...] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk registrations preview <id>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const variables = flagVars(args);
    const preview = await previewRegistrationHint(inspection, id, { variables });
    if (!preview) {
      process.stderr.write(`Registration hint "${id}" not found.\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(preview) + '\n');
      return 0;
    }
    process.stdout.write(header(`Registration hint preview: ${preview.hintId}`));
    process.stdout.write(`  title           ${preview.title}\n`);
    process.stdout.write(
      `  target file     ${preview.targetFile ?? '(ambiguous — multiple candidates)'}\n`,
    );
    if (preview.candidates.length > 1) {
      process.stdout.write(`  candidates      ${preview.candidates.length}\n`);
      for (const c of preview.candidates) process.stdout.write(`    • ${c}\n`);
    }
    process.stdout.write(`  ambiguous       ${preview.ambiguous ? 'YES' : 'no'}\n`);
    process.stdout.write(`  human review    ${preview.requiresHumanReview ? 'required' : 'optional'}\n`);
    if (preview.missingVariables.length > 0) {
      process.stdout.write(
        `\n  ⚠ missing required variables: ${preview.missingVariables.join(', ')}\n`,
      );
    }
    process.stdout.write('\nOperations:\n');
    for (const op of preview.operations) {
      process.stdout.write(`  • ${op.description}\n`);
      if (op.snippet) {
        const snippet = op.snippet.split('\n').map((l) => '      ' + l).join('\n');
        process.stdout.write(snippet + '\n');
      }
    }
    if (preview.safetyNotes.length > 0) {
      process.stdout.write('\nSafety notes:\n');
      for (const s of preview.safetyNotes) process.stdout.write(`  • ${s}\n`);
    }
    if (preview.validationCommands.length > 0) {
      process.stdout.write('\nValidation commands:\n');
      for (const c of preview.validationCommands) process.stdout.write(`  $ ${c}\n`);
    }
    process.stdout.write(`\n${preview.nextCommand}\n`);
    return 0;
  },
};

const registrationsPlanCommand: ICommandHandler = {
  name: 'plan',
  description:
    'Emit a saved plan from a registration hint. Ambiguous targets must be resolved by passing --target <file>. Read-only at the inspector level; the resulting saved plan flows through `shrk apply --verify-signature` like any other plan.',
  usage:
    'shrk registrations plan <id> [--target <file>] [--var key=value ...] [--save-plan <file>] [--sign] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk registrations plan <id> [--target <file>]\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entry = await getRegistrationHint(inspection, id);
    if (!entry) {
      process.stderr.write(`Registration hint "${id}" not found.\n`);
      return 1;
    }
    const target = flagString(args, 'target');
    const variables = flagVars(args);
    const preview = await previewRegistrationHint(inspection, id, { variables });
    if (!preview) {
      process.stderr.write(`Failed to build preview for "${id}".\n`);
      return 1;
    }
    // Ambiguous target must be refused unless --target is given.
    if (preview.ambiguous && !target) {
      if (flagBool(args, 'json')) {
        process.stdout.write(
          asJson({
            error: 'ambiguous-target',
            hintId: id,
            candidates: preview.candidates,
            suggestion: `Pass --target <file> to pick one of the ${preview.candidates.length} candidates.`,
          }) + '\n',
        );
      } else {
        process.stderr.write(
          `Registration hint "${id}" has ${preview.candidates.length} candidate target files; pass --target <file>:\n`,
        );
        for (const c of preview.candidates) process.stderr.write(`  • ${c}\n`);
      }
      return 1;
    }
    // Missing target -> conflict.
    const resolvedTarget = target ?? preview.targetFile;
    if (!resolvedTarget) {
      process.stderr.write(`Registration hint "${id}" has no resolvable target (no targetFile, no --target).\n`);
      return 1;
    }
    if (preview.missingVariables.length > 0) {
      process.stderr.write(
        `Missing required variables: ${preview.missingVariables.join(', ')}\n`,
      );
      return 1;
    }
    // Build the saved plan: each hint operation becomes an expectedChange
    // against the resolved target file.
    const expectedChanges = preview.operations.map((op) => {
      const operation: Record<string, unknown> = { kind: op.kind };
      if (op.anchor !== undefined) operation['anchor'] = op.anchor;
      if (op.snippet !== undefined) operation['snippet'] = op.snippet;
      const sizeBytes = op.snippet ? Buffer.byteLength(op.snippet, 'utf8') : 0;
      return {
        type: op.kind,
        relativePath: resolvedTarget,
        sizeBytes,
        operation,
      };
    });
    const saved = {
      schema: 'sharkcraft.plan/v2' as const,
      templateId: REGISTRATION_HINT_SYNTHETIC_TEMPLATE,
      variables: { hintId: id, target: resolvedTarget, ...variables },
      projectRoot: cwd,
      createdAt: new Date().toISOString(),
      expectedChanges,
      note: preview.requiresHumanReview ? 'Human review required before apply.' : undefined,
    };
    const savePlanPath = flagString(args, 'save-plan');
    if (savePlanPath) {
      let toWrite = saved as unknown as ISavedPlan;
      if (flagBool(args, 'sign')) {
        const signed = signPlan(toWrite);
        if (signed.ok) toWrite = signed.value;
      }
      const abs = nodePath.isAbsolute(savePlanPath)
        ? savePlanPath
        : nodePath.resolve(cwd, savePlanPath);
      const writeResult = savePlanToFile(toWrite, abs);
      if (!writeResult.ok) {
        process.stderr.write(`Failed to save plan: ${writeResult.error.message}\n`);
        return 1;
      }
      if (!flagBool(args, 'json')) {
        process.stdout.write(`Saved registration-hint plan to ${abs}\n`);
        process.stdout.write(`Apply: shrk apply ${abs} --verify-signature\n`);
      } else {
        process.stdout.write(asJson({ saved: abs, plan: saved }) + '\n');
      }
      return 0;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(saved) + '\n');
    } else {
      process.stdout.write(header(`Registration hint plan: ${id}`));
      process.stdout.write(`  target file     ${resolvedTarget}\n`);
      process.stdout.write(`  human review    ${preview.requiresHumanReview ? 'required' : 'optional'}\n`);
      process.stdout.write(`  operations      ${expectedChanges.length}\n`);
      process.stdout.write('\nPass --save-plan <file> to write the saved plan.\n');
    }
    return 0;
  },
};

export const registrationsCommand: ICommandHandler = {
  name: 'registrations',
  description:
    'Inspect/preview/plan pack-contributed registration hints (downstream registration steps for generated constructs).',
  usage: 'shrk registrations <list|get|doctor|preview|plan> ...',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const rest = { ...args, positional: args.positional.slice(1) };
    if (sub === 'list') return (await registrationsListCommand.run(rest)) as number;
    if (sub === 'get') return (await registrationsGetCommand.run(rest)) as number;
    if (sub === 'doctor') return (await registrationsDoctorCommand.run(rest)) as number;
    if (sub === 'preview') return (await registrationsPreviewCommand.run(rest)) as number;
    if (sub === 'plan') return (await registrationsPlanCommand.run(rest)) as number;
    process.stderr.write('Usage: shrk registrations <list|get|doctor|preview|plan> ...\n');
    return 2;
  },
};
