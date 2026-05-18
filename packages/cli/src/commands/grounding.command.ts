/**
 * `shrk grounding "<task>"` — thin context primer for
 * plugin / skill consumption. Read-only. JSON-first output.
 */

import { buildGrounding, inspectSharkcraft } from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const groundingCommand: ICommandHandler = {
  name: 'grounding',
  description:
    'Emit task-relevant rules / knowledge / paths / templates / verification IDs as JSON. Read-only. Pure composition of the task-packet ranker — no LLM, no shell, no writes.',
  usage: 'shrk grounding "<task>" [--limit 5] [--max-tokens 2500] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const task = args.positional[0];
    if (!task || task.trim().length === 0) {
      process.stderr.write('Usage: shrk grounding "<task>"\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const limit = flagNumber(args, 'limit') ?? 5;
    const maxTokens = flagNumber(args, 'max-tokens') ?? 2500;
    const report = buildGrounding(task, inspection, { limit, maxTokens });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(report) + '\n');
      return 0;
    }
    process.stdout.write(header(`Grounding: ${task}`));
    process.stdout.write(`  rules:     ${report.rules.length}\n`);
    process.stdout.write(`  knowledge: ${report.knowledge.length}\n`);
    process.stdout.write(`  paths:     ${report.paths.length}\n`);
    process.stdout.write(`  templates: ${report.templates.length}\n`);
    process.stdout.write(`  verification IDs (trusted): ${report.verificationCommandIds.join(', ') || '(none)'}\n`);
    if (report.rules.length > 0) {
      process.stdout.write('\nRules:\n');
      for (const r of report.rules) {
        process.stdout.write(`  ${r.id.padEnd(40)} [${r.priority ?? '-'}] ${r.title}\n`);
      }
    }
    if (report.knowledge.length > 0) {
      process.stdout.write('\nKnowledge:\n');
      for (const k of report.knowledge) {
        process.stdout.write(`  ${k.id.padEnd(40)} ${k.title}\n`);
      }
    }
    if (report.templates.length > 0) {
      process.stdout.write('\nTemplates:\n');
      for (const t of report.templates) {
        process.stdout.write(`  ${t.id.padEnd(40)} ${t.name}\n`);
      }
    }
    process.stdout.write(`\nPass --json for the structured \`sharkcraft.grounding/v1\` payload.\n`);
    return 0;
  },
};
