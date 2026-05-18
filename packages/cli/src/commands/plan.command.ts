import * as nodePath from 'node:path';
import {
  buildApplyDispatchTrace,
  inspectSharkcraft,
  renderApplyDispatchTraceText,
  reviewSavedPlan,
} from '@shrkcrft/inspector';
import { readPlanFromFile } from '@shrkcrft/generator';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { planSimulateCommand } from './plan-simulate.command.ts';

export const planReviewCommand: ICommandHandler = {
  name: 'review',
  description:
    'Inspect a saved generation plan (sharkcraft.plan/v1 JSON): files to create/update, signature status, related rules/paths, missing-tests heuristic, boundary risks, verification commands. Pass --trace-dispatch to include the apply dispatch trace. Read-only.',
  usage: 'shrk plan review <plan.json> [--cwd <dir>] [--json] [--trace-dispatch]',
  async run(args: ParsedArgs): Promise<number> {
    const planPath = args.positional[0];
    if (!planPath) {
      process.stderr.write('Usage: shrk plan review <plan.json>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    let report;
    try {
      report = reviewSavedPlan(inspection, nodePath.resolve(planPath));
    } catch (e) {
      process.stderr.write(`Failed to review plan: ${(e as Error).message}\n`);
      return 1;
    }
    // Optional dispatch trace.
    const wantTrace = flagBool(args, 'trace-dispatch');
    let dispatchTrace: ReturnType<typeof buildApplyDispatchTrace> | null = null;
    if (wantTrace) {
      const planResult = readPlanFromFile(nodePath.resolve(planPath));
      if (planResult.ok) {
        dispatchTrace = buildApplyDispatchTrace({
          plan: planResult.value,
          inspection,
          dryRun: false,
          verifySignature: true,
        });
      }
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({ ...report, ...(dispatchTrace ? { dispatchTrace } : {}) }) + '\n',
      );
      return 0;
    }
    if (dispatchTrace) {
      process.stdout.write(renderApplyDispatchTraceText(dispatchTrace));
      process.stdout.write('\n');
    }
    process.stdout.write(header(`Plan review: ${planPath}`));
    if (report.templateId) process.stdout.write(kv('template', report.templateId) + '\n');
    process.stdout.write(kv('signature', `${report.signature}${report.signatureMessage ? ' — ' + report.signatureMessage : ''}`) + '\n');
    const createCount = report.files.filter((f) => f.type === 'create').length;
    const updateCount = report.files.filter((f) => f.modifiesExisting === true).length;
    const conflictCount = report.files.filter((f) => f.type === 'conflict').length;
    process.stdout.write(kv('files', String(report.files.length)) + '\n');
    process.stdout.write(kv('creates', String(createCount)) + '\n');
    process.stdout.write(kv('modifies existing', String(updateCount)) + '\n');
    if (conflictCount > 0) process.stdout.write(kv('conflicts', String(conflictCount)) + '\n');
    process.stdout.write('\n');
    for (const f of report.files) {
      const marker = f.modifiesExisting ? ' [modifies existing]' : '';
      process.stdout.write(
        `  ${f.type.padEnd(14)} ${f.relativePath}${marker}${f.reason ? '  (' + f.reason + ')' : ''}\n`,
      );
    }
    if (updateCount > 0) {
      process.stdout.write(
        `\n  HUMAN REVIEW REQUIRED — ${updateCount} entry/entries modify existing files.\n`,
      );
    }
    if (report.folderOps.length > 0) {
      process.stdout.write('\nFolder operations:\n');
      for (const op of report.folderOps) {
        const head =
          op.kind === 'rename-folder' ? 'RENAME-FOLDER' : 'DELETE-FOLDER';
        const arrow = op.newPath ? ` → ${op.newPath}` : '';
        const safety = op.safety === 'safe' ? 'SAFE' : 'UNSAFE';
        process.stdout.write(
          `  ${head} ${op.targetPath}${arrow}  [${safety}${
            op.safetyReason ? ` — ${op.safetyReason}` : ''
          }]  (requires --${op.requiresAllowFlag.replace('+', ' --')})\n`,
        );
      }
      process.stdout.write(
        `\n  HUMAN REVIEW REQUIRED — folder ops mutate disk structure. They run only when --allow-folder-ops (and --allow-delete-folder for deletes) is passed.\n`,
      );
    }
    if (report.affectedPaths.length) {
      process.stdout.write('\nAffected path conventions:\n');
      for (const p of report.affectedPaths) process.stdout.write(`  • ${p}\n`);
    }
    if (report.missingTestsHeuristic.length) {
      process.stdout.write('\nMissing tests heuristic:\n');
      for (const m of report.missingTestsHeuristic) process.stdout.write(`  • ${m}\n`);
    }
    if (report.potentialBoundaryConcerns.length) {
      process.stdout.write('\nBoundary concerns (current state):\n');
      for (const c of report.potentialBoundaryConcerns) {
        process.stdout.write(`  ${c.severity.toUpperCase().padEnd(8)} ${c.file}:${c.line}  ${c.importSpecifier}  (${c.ruleId})\n`);
      }
    }
    if (report.planIntroducedBoundaryConcerns.length) {
      process.stdout.write('\nBoundary concerns introduced by this plan:\n');
      for (const c of report.planIntroducedBoundaryConcerns) {
        process.stdout.write(
          `  ${c.severity.toUpperCase().padEnd(8)} ${c.file}:${c.line}  ${c.importSpecifier}  (${c.ruleId})\n`,
        );
        if (c.resolvedVia) process.stdout.write(`           resolved via: ${c.resolvedVia}\n`);
        if (c.suggestedFix) process.stdout.write(`           ↳ ${c.suggestedFix}\n`);
      }
    }
    if (report.verificationCommands.length) {
      process.stdout.write('\nVerification commands:\n');
      for (const c of report.verificationCommands) process.stdout.write(`  $ ${c}\n`);
    }
    process.stdout.write('\n' + report.humanApprovalReminder + '\n');
    return 0;
  },
};

/**
 * `shrk plan <subcommand>` parent — currently just exposes `review`. We avoid
 * exposing destructive subcommands here; writes go through `shrk apply`.
 */
export const planParentCommand: ICommandHandler = {
  name: 'plan',
  description: 'Inspect generation plans. Subcommand required.',
  usage: 'shrk plan review|simulate <plan.json>',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'review') {
      return (await planReviewCommand.run({
        ...args,
        positional: args.positional.slice(1),
      })) as number;
    }
    if (sub === 'simulate') {
      return (await planSimulateCommand.run({
        ...args,
        positional: args.positional.slice(1),
      })) as number;
    }
    process.stderr.write('Usage: shrk plan review|simulate <plan.json>\n');
    return 2;
  },
};
