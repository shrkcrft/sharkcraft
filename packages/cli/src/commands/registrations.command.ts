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
  assetDoctorProposedExit,
  ContributionKind,
  inspectSharkcraft,
  listRegistrationHints,
  buildRegistrationHintDoctorReport,
  getRegistrationHint,
  previewRegistrationHint,
  settledUnitStates,
} from '@shrkcrft/inspector';
import { formatCoverage, type IVerdictCoverage } from '@shrkcrft/core';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { assetDoctorFailingUnits } from '../gates/asset-doctor-failing-units.ts';
import { assetDoctorFailureLine } from '../gates/asset-doctor-failure-line.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import {
  flagBool,
  flagString,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { writeRejectedEntriesNote } from '../output/rejected-entries-note.ts';
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
    // A hint its loader refused is named, never silently absent (round 12, 12.1).
    const note = { ...(source ? { source } : {}), next: 'shrk registrations doctor' };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(filtered) + '\n');
      await writeRejectedEntriesNote(inspection, [ContributionKind.RegistrationHint], { ...note, json: true });
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
    await writeRejectedEntriesNote(inspection, [ContributionKind.RegistrationHint], note);
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
  description:
    'Validate registration hints (local + pack): load issues, and every hint’s discovery against the live tree — verified / ambiguous / dead / unverified. Exit 0 pass · 1 errors · 2 a dead or capped discovery.',
  usage: 'shrk registrations doctor [--json] [--strict] [--fail-on-dead-units] [--allow-empty]',
  booleanFlags: new Set(['json', 'strict', 'fail-on-dead-units', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    // THE discovery authority — the same candidate set `preview` acts on.
    const report = await buildRegistrationHintDoctorReport(inspection);
    const errors = report.issues.filter((i) => i.severity === 'error').length;
    const warnings = report.issues.filter((i) => i.severity === 'warning').length;
    // THE asset-doctor proposal (round 13): errors, warnings under --strict, and
    // every settled selector unit THE --fail-on-dead-units predicate fails (a
    // dead one, or a stale LOCAL expectEmpty marker — a pack's is INFO).
    const proposed = assetDoctorProposedExit(
      { errors, warnings, units: report.liveness.units },
      { strict: flagBool(args, 'strict'), failOnDeadUnits: flagBool(args, 'fail-on-dead-units') },
    );
    // No hint declared examined nothing: NOT VERIFIED (2) — the answer the
    // helper / checks / conventions / templates doctors give an empty input,
    // never a 0 that reads as "every hint verified" — unless `--allow-empty`
    // accepts it (printed). Added here, not in the inspector report, so the
    // self-config doctor (which folds these findings) is not vetoed by a repo
    // that simply declares no hints.
    const coverage: readonly IVerdictCoverage[] =
      report.totals.hints === 0
        ? [
            ...report.coverage,
            {
              unit: 'registration hints',
              expected: 0,
              examined: 0,
              reason: 'no registration hints declared',
              ...allowEmptyValve(args, 0),
            },
          ]
        : report.coverage;
    const settled = settleVerdict(proposed, coverage);
    // THE units that fail this run (round 13 review) — printed and in --json,
    // so a 1 from --fail-on-dead-units is never silent about why.
    const failing = assetDoctorFailingUnits(report.liveness.units, {
      failOnDeadUnits: flagBool(args, 'fail-on-dead-units'),
      strict: flagBool(args, 'strict'),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          issues: report.issues,
          failingUnits: failing.map((u) => ({ list: u.list, unit: u.unit, state: u.state, message: u.message })),
          hints: report.hints,
          totals: report.totals,
          coverage,
          deadUnits: report.deadUnits,
          units: settledUnitStates([report.liveness]),
          exitCode: settled.exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
          accepted: settled.accepted,
        }) + '\n',
      );
      return settled.exit;
    }
    const t = report.totals;
    // Never "N issues" alone: 0 issues must not read as "N hints verified".
    process.stdout.write(
      header(
        `Registration hint doctor — ${t.hints} hint(s): ${t.verified} verified · ${t.ambiguous} ambiguous · ${t.dead} dead · ${t.unverified} unverified${t.intendedEmpty > 0 ? ` · ${t.intendedEmpty} intended-empty` : ''}`,
      ),
    );
    // The status column fits every status the doctor prints — `intended-empty`
    // (14 wide) overflowed the old 11-wide column into the id (round 13, K11).
    const statusWidth = Math.max(11, ...report.hints.map((h) => h.status.length));
    for (const h of report.hints) {
      process.stdout.write(
        `  ${h.status.padEnd(statusWidth)} ${h.id.padEnd(36)} ${h.discovery} (${h.candidates} candidate(s))\n`,
      );
    }
    for (const c of report.coverage) process.stdout.write(`  coverage    ${formatCoverage(c)}\n`);
    if (report.issues.length > 0) {
      process.stdout.write(`\nIssues (${report.issues.length}):\n`);
      for (const i of report.issues) {
        process.stdout.write(
          `  ${i.severity.toUpperCase().padEnd(7)} ${i.code.padEnd(30)} ${i.message}\n`,
        );
      }
    }
    // A stale LOCAL expectEmpty marker withholds the ✓ (a pack's is INFO: the
    // consumer cannot edit it); an intended-empty one is accepted, printed below.
    const staleLocal = report.liveness.wentLive.filter((u) => u.mark?.packageName === undefined).length;
    const clean =
      t.hints === 0
        ? 'No registration hints declared — nothing to verify.'
        : warnings > 0
          ? `No blocking registration-hint issues — ${warnings} warning(s) reported above.`
          : staleLocal > 0
            ? `No blocking registration-hint issues — ${staleLocal} expectEmpty marker(s) went live (listed above; remove the markers).`
            : `Every hint's discovery resolves (${t.verified} verified, ${t.ambiguous} ambiguous${t.intendedEmpty > 0 ? `, ${t.intendedEmpty} intended empty` : ''}). ✓`;
    const line = verdictLine(settled, clean);
    if (line) process.stdout.write('\n' + line + '\n');
    // Round 13 review: a 1 from --fail-on-dead-units names its units — the
    // doctor printed only INFO issue lines, and `verdictLine` prints nothing
    // for a 1 without a shortfall.
    if (settled.exit === 1) {
      const failure = assetDoctorFailureLine('registration-hint doctor', failing);
      if (failure) process.stdout.write('\n' + failure + '\n');
    }
    return settled.exit;
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
  // Declared (round 11 review): the dispatcher guard refuses an unknown verb
  // with the closest one, and the declared walk reaches `registrations doctor`
  // — a verdict verb, so a bad flag there exits 3, labelled with its own path.
  positionals: PositionalMode.None,
  subverbs: [
    {
      name: registrationsListCommand.name,
      description: registrationsListCommand.description,
      usage: registrationsListCommand.usage,
      positionals: PositionalMode.None,
    },
    {
      name: registrationsGetCommand.name,
      description: registrationsGetCommand.description,
      usage: registrationsGetCommand.usage,
      positionals: PositionalMode.Free,
    },
    {
      name: registrationsDoctorCommand.name,
      description: registrationsDoctorCommand.description,
      usage: registrationsDoctorCommand.usage,
      positionals: PositionalMode.None,
    },
    {
      name: registrationsPreviewCommand.name,
      description: registrationsPreviewCommand.description,
      usage: registrationsPreviewCommand.usage,
      positionals: PositionalMode.Free,
    },
    {
      name: registrationsPlanCommand.name,
      description: registrationsPlanCommand.description,
      usage: registrationsPlanCommand.usage,
      positionals: PositionalMode.Free,
    },
  ],
  // The group parses every subverb's argv, so the subverbs' boolean flags live here too.
  booleanFlags: new Set(['json', 'strict', 'fail-on-dead-units', ALLOW_EMPTY_FLAG]),
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
