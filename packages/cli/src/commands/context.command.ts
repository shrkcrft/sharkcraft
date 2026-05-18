import { entrypointBanner, inspectSharkcraft } from '@shrkcrft/inspector';
import { buildContext } from '@shrkcrft/context';
import {
  buildUniversalSearch,
  explainTaskRouting,
  recommendCommands,
  renderOverviewText,
  buildProjectOverview,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

export const contextCommand: ICommandHandler = {
  name: 'context',
  description: 'Build relevant AI-ready context for a task (token-budgeted). Subcommands: build / refresh / status.',
  usage: 'shrk context [build|refresh|status] --task "<task>" [--max-tokens 3000] [--framework x] [--area y] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    // Dispatch subcommands (build / refresh / status) based on first positional.
    const sub = args.positional[0];
    if (sub === 'build' || sub === 'refresh' || sub === 'status') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      const { contextBuildCommand, contextRefreshCommand, contextStatusCommand } = await import('./task-context.command.ts');
      if (sub === 'build') return contextBuildCommand.run(sliced);
      if (sub === 'refresh') return contextRefreshCommand.run(sliced);
      return contextStatusCommand.run(sliced);
    }
    const task = flagString(args, 'task');
    if (!task) {
      process.stderr.write('Missing --task\n');
      return 2;
    }
    const framework = flagString(args, 'framework');
    const area = flagString(args, 'area');
    const tags = flagList(args, 'tag');
    const scope = flagList(args, 'scope');
    const maxTokens = flagNumber(args, 'max-tokens') ?? flagNumber(args, 'maxTokens');
    const noExamples = flagBool(args, 'no-examples');
    const noTemplates = flagBool(args, 'no-templates');
    const noRules = flagBool(args, 'no-rules');
    const noPaths = flagBool(args, 'no-paths');
    const includeDocs = flagBool(args, 'include-docs');
    const includeCommands = flagBool(args, 'include-commands');

    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);

    const result = buildContext(inspection.knowledgeEntries, {
      task,
      framework,
      area,
      tags,
      scope,
      maxTokens: maxTokens ?? inspection.config?.defaultMaxTokens ?? 3000,
      includeExamples: !noExamples,
      includeTemplates: !noTemplates,
      includeRules: !noRules,
      includePaths: !noPaths,
      includeDocs,
      includeCommands,
      projectOverview: renderOverviewText(overview),
    });

    // Surface top commands prominently before the long context body.
    // Auto-promote commands-first for action-like tasks (rename / add /
    // fix / refactor / remove / migrate / explore / wire). Pass --full to
    // see the long context body anyway.
    const actionVerbRe =
      /^(rename|add|fix|refactor|remove|delete|migrate|wire|explore|create|implement|update|introduce|build|extract|move|inline|generate|scaffold)\b/i;
    const isActionLike = actionVerbRe.test(task.trim());
    const wantsFull = flagBool(args, 'full');
    const commandsFirst = flagBool(args, 'commands-first') || (isActionLike && !wantsFull);
    let commandRecommendations: Awaited<ReturnType<typeof recommendCommands>> | null = null;
    let routingMatches: Awaited<ReturnType<typeof explainTaskRouting>> = [];
    let searchReport: Awaited<ReturnType<typeof buildUniversalSearch>> | null = null;
    try {
      commandRecommendations = await recommendCommands(inspection, task);
      routingMatches = await explainTaskRouting(inspection, task);
      searchReport = await buildUniversalSearch(inspection, task, {});
    } catch {
      // ignore — fall back to legacy context only.
    }

    if (flagBool(args, 'json') || flagBool(args, 'machine-json')) {
      process.stdout.write(
        asJson({
          ...result,
          commands: commandRecommendations,
          routingMatches,
          search: searchReport,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`Context for: ${task}`));
    // Entrypoint banner: commands surface first when present (already
    // done below), and the banner points operators at the agent-mcp + machine
    // alternatives so the role of each entrypoint is clear.
    process.stdout.write(`(${entrypointBanner('context')})\n\n`);
    process.stdout.write(
      `tokens ≈ ${result.totalTokens} / ${result.maxTokens}, sections: ${result.sections.length}\n`,
    );
    if (result.omittedSections.length) {
      process.stdout.write(`omitted (budget): ${result.omittedSections.join(', ')}\n`);
    }
    if (commandRecommendations && commandRecommendations.recommendations.length > 0) {
      process.stdout.write('\nTop commands:\n');
      for (const r of commandRecommendations.recommendations.slice(0, 4)) {
        process.stdout.write(`  $ ${r.command}\n`);
      }
    }
    if (routingMatches.length > 0) {
      process.stdout.write('\nRouting hints:\n');
      for (const m of routingMatches.slice(0, 3)) {
        process.stdout.write(`  • ${m.hint.id}  ${m.hint.title}\n`);
      }
    }
    // Default human text mode keeps the output short. The long
    // context body is one flag away via `--full`. JSON / commands-first /
    // markdown paths are unchanged.
    if (commandsFirst || !wantsFull) {
      if (!wantsFull) {
        process.stdout.write(
          '\n(text mode is summary-only — pass --full for the long context body, --json for machine output.)\n',
        );
      } else if (isActionLike && !flagBool(args, 'commands-first')) {
        process.stdout.write(
          '\n(action-like task → commands-first; pass --full to see the long context body.)\n',
        );
      }
      return 0;
    }

    process.stdout.write('\n');
    process.stdout.write(result.body + '\n');
    return 0;
  },
};
