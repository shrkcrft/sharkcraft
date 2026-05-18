/**
 * Top-level `shrk feedback` dispatcher, plus the `feedback rules
 * list|doctor` family.
 *
 * The registry routes subcommands when the second positional is a real
 * verb. This file maps `shrk feedback <verb>` → the verb-specific
 * handler, while also accepting `shrk feedback <file>` (defaults to
 * `ingest`).
 */
import type { ICommandHandler, ParsedArgs } from '../command-registry.ts';
import {
  feedbackActionsCommand,
  feedbackBacklogCommand,
  feedbackConvertToBacklogCommand,
  feedbackIngestCommand,
  feedbackPlanCommand,
  feedbackPromptCommand,
  feedbackRulesDoctorCommand,
  feedbackRulesListCommand,
  feedbackSummarizeCommand,
} from './feedback.command.ts';

const VERBS: Record<string, ICommandHandler> = {
  ingest: feedbackIngestCommand,
  summarize: feedbackSummarizeCommand,
  actions: feedbackActionsCommand,
  'convert-to-backlog': feedbackConvertToBacklogCommand,
  // v2
  backlog: feedbackBacklogCommand,
  prompt: feedbackPromptCommand,
  plan: feedbackPlanCommand,
};

const RULES_VERBS: Record<string, ICommandHandler> = {
  list: feedbackRulesListCommand,
  doctor: feedbackRulesDoctorCommand,
};

export const feedbackCommand: ICommandHandler = {
  name: 'feedback',
  description:
    'Parse freeform feedback markdown into structured findings. Subcommands: ingest|summarize|actions|convert-to-backlog|rules. Read-only.',
  usage:
    'shrk feedback <ingest|summarize|actions|convert-to-backlog> <file> [--with-pack-rules] [--json]\n  shrk feedback rules <list|doctor> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const verb = args.positional[0];
    if (verb === 'rules') {
      const sub = args.positional[1];
      const next: ParsedArgs = { ...args, positional: args.positional.slice(2) };
      if (sub && RULES_VERBS[sub]) {
        return RULES_VERBS[sub]!.run(next);
      }
      // Default rules verb is list.
      return feedbackRulesListCommand.run(next);
    }
    if (verb && VERBS[verb]) {
      const sub: ParsedArgs = { ...args, positional: args.positional.slice(1) };
      return VERBS[verb]!.run(sub);
    }
    // If `verb` looks like a known SharkCraft verb (e.g. "list" / "rules")
    // but the user typed it in the wrong position, surface a did-you-mean
    // hint rather than silently trying to read the verb as a file.
    if (verb && !verb.includes('/') && !verb.includes('.')) {
      const { existsSync } = await import('node:fs');
      const isFile = existsSync(verb);
      if (!isFile) {
        const known = [...Object.keys(VERBS), 'rules list', 'rules doctor'];
        const closest = known.find((k) => k === verb || k.startsWith(verb + ' '));
        if (closest) {
          process.stderr.write(`Unknown subcommand: feedback ${verb}\n`);
          process.stderr.write(`Did you mean: shrk feedback ${closest}?\n`);
          return 2;
        }
        if (verb === 'list') {
          process.stderr.write(`Unknown subcommand: feedback ${verb}\n`);
          process.stderr.write('Did you mean: shrk feedback rules list?\n');
          return 2;
        }
      }
    }
    // Default: treat first positional as a file → ingest.
    if (verb) {
      return feedbackIngestCommand.run(args);
    }
    process.stderr.write(
      'Usage: shrk feedback <ingest|summarize|actions|convert-to-backlog|rules> ...\n',
    );
    return 2;
  },
};
