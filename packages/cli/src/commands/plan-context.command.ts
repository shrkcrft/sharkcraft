import { planContext } from '@shrkcrft/context-planner';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * `shrk plan-context` — produce a deterministic, token-budgeted context
 * pack for an AI coding agent. Reads the code graph + (optionally) the
 * rule-graph bridge.
 *
 * Read-only. The pack is whatever the planner decides; the agent uses
 * it as the starting point for its conversation.
 */
export const planContextCommand: ICommandHandler = {
  name: 'plan-context',
  description:
    'Produce a deterministic, token-budgeted context pack (`sharkcraft.context-pack/v1`) for an AI agent: ranked files, applicable rules, likely tests, surfaced risks, do-not-touch zones.',
  usage:
    'shrk plan-context "<task>" [--budget N] [--max-files N] [--hint-file <path>] [--hint-package <prefix>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const task = args.positional[0];
    if (!task) {
      process.stderr.write(this.usage + '\n');
      return 2;
    }
    const budget = Number(flagString(args, 'budget') ?? '8000');
    const maxFiles = Number(flagString(args, 'max-files') ?? '30');
    const hintedFiles = collectMulti(args, 'hint-file');
    const hintedPackages = collectMulti(args, 'hint-package');
    const pack = planContext({
      projectRoot: cwd,
      task,
      budgetTokens: budget,
      maxFiles,
      ...(hintedFiles.length > 0 ? { hintedFiles } : {}),
      ...(hintedPackages.length > 0 ? { hintedPackages } : {}),
    });
    if (wantJson) {
      process.stdout.write(asJson(pack) + '\n');
      return 0;
    }
    process.stdout.write(header(`Context pack: ${task}`));
    process.stdout.write(kv('intent', pack.intent) + '\n');
    process.stdout.write(kv('files', String(pack.files.length)) + '\n');
    process.stdout.write(kv('rules', String(pack.rules.length)) + '\n');
    process.stdout.write(kv('paths', String(pack.paths.length)) + '\n');
    process.stdout.write(kv('templates', String(pack.templates.length)) + '\n');
    process.stdout.write(kv('tests', String(pack.tests.length)) + '\n');
    process.stdout.write(kv('risks', String(pack.risks.length)) + '\n');
    process.stdout.write(
      kv('budget', `${pack.budget.used}/${pack.budget.requested} tokens` + (pack.budget.truncated ? ' (truncated)' : '')) + '\n',
    );
    if (pack.files.length > 0) {
      process.stdout.write('\nTop files:\n');
      for (const f of pack.files.slice(0, 15)) {
        const reason = f.reasons[0] ? `  [${f.reasons[0]}]` : '';
        process.stdout.write(`  ${f.score.toFixed(2)}  ${f.path}${reason}\n`);
      }
    }
    if (pack.tests.length > 0) {
      process.stdout.write('\nLikely tests:\n');
      for (const t of pack.tests.slice(0, 5)) process.stdout.write(`  ${t}\n`);
    }
    if (pack.risks.length > 0) {
      process.stdout.write('\nRisks:\n');
      for (const r of pack.risks) process.stdout.write(`  • [${r.kind}] ${r.label}\n`);
    }
    for (const d of pack.diagnostics.slice(0, 5)) process.stdout.write(`! ${d}\n`);
    return 0;
  },
};

function collectMulti(args: ParsedArgs, name: string): string[] {
  const list = args.multiFlags.get(name);
  if (list) return [...list];
  const single = flagString(args, name);
  return single ? [single] : [];
}
