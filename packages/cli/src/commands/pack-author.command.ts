/**
 * Pack asset authoring + pending CLI surface.
 *
 *   - `shrk pack author status`
 *   - `shrk pack author preview --kind <kind> --id <id>`
 *   - `shrk pack author pending` (alias: `shrk packs pending`)
 *   - `shrk pack author validate`
 *
 * Knowledge supports a full preview; rule and template forward to the
 * dedicated scaffolders; the remaining kinds return an honest deferral.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildPackAuthorPreview,
  buildPackAuthorStatus,
  buildPackAuthorValidatePlan,
  buildPackPendingReport,
  inspectSharkcraft,
  PackAuthorKind,
  renderPackPendingMarkdown,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { rulesScaffoldCommand } from './rules.command.ts';
import { templatesScaffoldCommand } from './templates.command.ts';

function parseAuthorKind(value: string | undefined): PackAuthorKind | null {
  switch ((value ?? '').toLowerCase()) {
    case 'knowledge':
      return PackAuthorKind.Knowledge;
    case 'search-tuning':
      return PackAuthorKind.SearchTuning;
    case 'feedback-rule':
      return PackAuthorKind.FeedbackRule;
    case 'agent-test':
      return PackAuthorKind.AgentTest;
    case 'convention':
      return PackAuthorKind.Convention;
    case 'task-routing-hint':
      return PackAuthorKind.TaskRoutingHint;
    case 'registration-hint':
      return PackAuthorKind.RegistrationHint;
    case 'scaffold-pattern':
      return PackAuthorKind.ScaffoldPattern;
    default:
      return null;
  }
}

/**
 * Kinds that pack-author preview can scaffold end-to-end (no deferred
 * stubs). Rule and template forward to the existing `rules scaffold` /
 * `templates scaffold` commands; knowledge stays on the
 * `buildPackAuthorPreview` path.
 */
type DelegatedKind = 'rule' | 'template';
function isDelegatedKind(value: string | undefined): value is DelegatedKind {
  return value === 'rule' || value === 'template';
}

export const packAuthorStatusCommand: ICommandHandler = {
  name: 'status',
  description: 'Pack author status — kind-by-kind inventory of contributions, pending drafts, and signature state.',
  usage: 'shrk pack author status [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const status = buildPackAuthorStatus(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(status) + '\n');
      return 0;
    }
    process.stdout.write(header('Pack author status'));
    process.stdout.write(`  generated: ${status.generatedAt}\n`);
    process.stdout.write(`  provenance ledger: ${status.provenanceExists ? 'present' : 'missing'}\n`);
    process.stdout.write(`  pack secret: ${status.secretAvailable ? 'available' : 'missing'}\n`);
    process.stdout.write(`  pending drafts: ${status.pendingDrafts}\n`);
    for (const f of status.pendingDraftFiles) process.stdout.write(`    - ${f}\n`);
    process.stdout.write('  contribution counts:\n');
    for (const [k, n] of Object.entries(status.contributionCounts)) {
      const support = status.authoringSupport[k] ?? 'deferred';
      process.stdout.write(`    ${k.padEnd(22)} ${String(n).padStart(3)}  (authoring: ${support})\n`);
    }
    process.stdout.write('  next commands:\n');
    for (const c of status.nextCommands) process.stdout.write(`    $ ${c}\n`);
    return 0;
  },
};

export const packAuthorPreviewCommand: ICommandHandler = {
  name: 'preview',
  description:
    'Pack author preview. Rule and template kinds forward to `rules scaffold` / `templates scaffold` (no deferred stub). Knowledge uses the dedicated preview path.',
  usage:
    'shrk pack author preview --kind <kind> --id <id> [--title <t>] [--reason <text>] [--write-preview] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const rawKind = (flagString(args, 'kind') ?? '').toLowerCase();
    const id = flagString(args, 'id') ?? args.positional[0];
    if (!id) {
      process.stderr.write('Missing --id <id>.\n');
      return 2;
    }

    // Rule kind: forward to `shrk rules scaffold`.
    if (rawKind === 'rule') {
      const forwarded: ParsedArgs = {
        positional: [],
        flags: new Map(args.flags),
        multiFlags: new Map(args.multiFlags),
        ...(args.globalCwd ? { globalCwd: args.globalCwd } : {}),
      };
      forwarded.flags.set('id', id);
      // `rules scaffold` accepts the same `--title`/`--reason`/`--write-preview` flags.
      const exit = await rulesScaffoldCommand.run(forwarded);
      if (!flagBool(args, 'json')) {
        process.stdout.write('\nNext (post-scaffold):\n');
        process.stdout.write(
          `  $ shrk apply --asset-preview .sharkcraft/fixes/rule-add-${id.replace(/[^a-z0-9.-]/gi, '-').toLowerCase()}.draft.ts --target sharkcraft/rules.ts\n`,
        );
        process.stdout.write('  $ shrk packs signature-status\n');
        process.stdout.write('  $ shrk provenance show ' + id + '\n');
      }
      return exit;
    }

    // Template kind: forward to `shrk templates scaffold`.
    if (rawKind === 'template') {
      const forwarded: ParsedArgs = {
        positional: [],
        flags: new Map(args.flags),
        multiFlags: new Map(args.multiFlags),
        ...(args.globalCwd ? { globalCwd: args.globalCwd } : {}),
      };
      forwarded.flags.set('id', id);
      const exit = await templatesScaffoldCommand.run(forwarded);
      if (!flagBool(args, 'json')) {
        const slug = id.replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
        process.stdout.write('\nNext (post-scaffold):\n');
        process.stdout.write(
          `  $ shrk apply --asset-preview .sharkcraft/authoring/templates/${slug}.draft.ts --target sharkcraft/templates.ts\n`,
        );
        process.stdout.write('  $ shrk packs signature-status\n');
        process.stdout.write('  $ shrk provenance show ' + id + '\n');
      }
      return exit;
    }

    // Knowledge + remaining kinds keep the existing dispatcher.
    const kind = parseAuthorKind(rawKind);
    if (!kind) {
      process.stderr.write(
        'Missing or unknown --kind. Use one of: knowledge, rule, template, search-tuning, feedback-rule, agent-test, convention, task-routing-hint, registration-hint, scaffold-pattern.\n',
      );
      return 2;
    }
    const preview = buildPackAuthorPreview({
      kind,
      assetId: id,
      ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason') ?? undefined } : {}),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(preview) + '\n');
      return 0;
    }
    process.stdout.write(header(`Pack author preview: ${kind} ${id}`));
    process.stdout.write(`  implemented: ${preview.implemented}\n`);
    if (!preview.implemented && preview.deferralNote) {
      process.stdout.write(`  note: ${preview.deferralNote}\n`);
    }
    process.stdout.write('\n  next commands:\n');
    for (const c of preview.nextCommands) process.stdout.write(`    $ ${c}\n`);
    return 0;
  },
};

// Silence the unused import when isDelegatedKind is the only public use.
void isDelegatedKind;

export const packAuthorPendingCommand: ICommandHandler = {
  name: 'pending',
  description:
    'Pack pending state — modified files, pending drafts, stale signatures, pending provenance, missing-secret guidance.',
  usage: 'shrk pack author pending [--write-todo] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const report = buildPackPendingReport(inspection);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
    } else {
      process.stdout.write(renderPackPendingMarkdown(report));
    }
    if (flagBool(args, 'write-todo') && report.secretMissingHint) {
      const reportsDir = nodePath.join(cwd, '.sharkcraft', 'reports');
      if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
      const todoPath = nodePath.join(reportsDir, 'pack-signing-todo.md');
      const lines: string[] = [];
      lines.push('# Pack signing TODO');
      lines.push('');
      lines.push(report.secretMissingHint);
      lines.push('');
      lines.push('## Next commands');
      lines.push('');
      for (const c of report.nextCommands) lines.push(`- \`${c}\``);
      lines.push('');
      writeFileSync(todoPath, lines.join('\n'), 'utf8');
      process.stdout.write(`\nWrote signing TODO at ${nodePath.relative(cwd, todoPath)}\n`);
    }
    return 0;
  },
};

export const packAuthorValidateCommand: ICommandHandler = {
  name: 'validate',
  description: 'Recommended validation commands after authoring. Read-only — does not execute commands.',
  usage: 'shrk pack author validate [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const plan = buildPackAuthorValidatePlan();
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(plan) + '\n');
      return 0;
    }
    process.stdout.write(header('Pack author validate plan'));
    process.stdout.write(`  ok: ${plan.ok}\n`);
    process.stdout.write('  recommended commands:\n');
    for (const c of plan.recommendedCommands) process.stdout.write(`    $ ${c}\n`);
    return 0;
  },
};

/**
 * Group dispatcher for `shrk pack author <verb>` — the registry only
 * supports 2-level commands (group + sub), so we expose `pack author` as
 * a top-level group whose sub is the verb. The wiring lives in main.ts:
 *   registerSubcommand('pack-author', packAuthorStatusCommand);
 * and we alias group: `aliasGroup('pack', 'pack-author')` does not work
 * because `pack` is already aliased to `packs`. We therefore expose:
 *   `shrk packs pending` → packAuthorPendingCommand (registered under packs)
 *   `shrk pack-author <verb>` → registered as the canonical group
 *   `shrk pack author <verb>` → also a top-level command that internally
 *     dispatches based on positional[0].
 */
export const packAuthorTopCommand: ICommandHandler = {
  name: 'pack',
  description: 'Alias: dispatches `pack author <verb>` to the pack-author commands.',
  usage:
    'shrk pack author <status|preview|pending|validate> [...]',
  async run(args: ParsedArgs): Promise<number> {
    if (args.positional[0] !== 'author') {
      process.stderr.write('Usage: shrk pack author <status|preview|pending|validate>\n');
      return 2;
    }
    const verb = args.positional[1];
    args.positional = args.positional.slice(2);
    switch (verb) {
      case 'status':
        return packAuthorStatusCommand.run(args);
      case 'preview':
        return packAuthorPreviewCommand.run(args);
      case 'pending':
        return packAuthorPendingCommand.run(args);
      case 'validate':
        return packAuthorValidateCommand.run(args);
      default:
        process.stderr.write(`Unknown pack author verb: ${verb ?? '(missing)'}\n`);
        process.stderr.write('Valid verbs: status, preview, pending, validate.\n');
        return 2;
    }
  },
};
