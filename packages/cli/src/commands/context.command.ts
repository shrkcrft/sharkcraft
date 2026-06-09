import { entrypointBanner, inspectSharkcraft } from '@shrkcrft/inspector';
import { buildContext } from '@shrkcrft/context';
import {
  loadIntentBenchmark,
  runIntentBenchmark,
  STARTER_INTENT_BENCHMARK,
  writeBenchmarkRun,
} from '@shrkcrft/context-planner';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
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
import type { IContextResult } from '@shrkcrft/context';

/**
 * Minimal JSON shape for agent / skill consumption — the context-side mirror
 * of `shrk task --compact`. Drops the heavy `body` and `request` echo and
 * carries the section map + structured action hints (so the agent reads
 * forbiddenActions / verificationCommands / preferredFlow directly instead of
 * regexing the markdown body). The schema marker is distinct so consumers can
 * tell the shapes apart at a glance.
 */
function minimalContext(
  task: string,
  result: IContextResult,
  commands: Awaited<ReturnType<typeof recommendCommands>> | null,
): Record<string, unknown> {
  return {
    schema: 'sharkcraft.context/v1-compact',
    task,
    tokens: { used: result.totalTokens, max: result.maxTokens },
    sections: result.sections.map((s) => ({
      title: s.title,
      tokens: s.tokens,
      ...(s.truncated ? { truncated: true } : {}),
    })),
    omittedSections: result.omittedSections,
    actionHints: result.actionHints,
    topCommands: (commands?.recommendations ?? []).slice(0, 5).map((r) => r.command),
  };
}

export const contextCommand: ICommandHandler = {
  name: 'context',
  description: 'Build relevant AI-ready context for a task (token-budgeted). Subcommands: build / refresh / status.',
  usage: 'shrk context [build|refresh|status] --task "<task>" [--max-tokens 3000] [--framework x] [--area y] [--json] [--compact] [--full]',
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
    if (sub === 'benchmark') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      return runContextBenchmark(sliced);
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
      // `--compact` emits a minimal, structured agent shape (no long body /
      // request echo) — the context-side mirror of `shrk task --compact`.
      // Carries the load-bearing action hints as structured data so the agent
      // never has to parse the markdown body. Full shape stays the default.
      if (flagBool(args, 'compact')) {
        process.stdout.write(asJson(minimalContext(task, result, commandRecommendations)) + '\n');
        return 0;
      }
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

async function runContextBenchmark(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  // `shrk context benchmark seed` writes a starter fixture to
  // sharkcraft/intent-benchmark.json. Useful first step for adopting
  // the surface — fixture is opinionated but small and easy to prune.
  if (args.positional[0] === 'seed') {
    return runContextBenchmarkSeed(cwd, args);
  }
  const noPersist = flagBool(args, 'no-persist');
  const benchmark = loadIntentBenchmark(cwd);
  if (!benchmark) {
    const msg = `No benchmark at sharkcraft/intent-benchmark.json. Create one with schema "sharkcraft.intent-benchmark/v1" and a "cases" array of { task, expected } entries.\n`;
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: 'benchmark-missing' }) + '\n');
      return 1;
    }
    process.stderr.write(msg);
    return 1;
  }
  const run = runIntentBenchmark(benchmark);
  if (!noPersist) {
    try {
      writeBenchmarkRun(cwd, run);
    } catch {
      // best-effort
    }
  }
  if (wantJson) {
    process.stdout.write(asJson(run) + '\n');
    return run.failed === 0 ? 0 : 1;
  }
  process.stdout.write(header('Intent classifier benchmark'));
  process.stdout.write(`  total       ${run.total}\n`);
  process.stdout.write(`  passed      ${run.passed}\n`);
  process.stdout.write(`  failed      ${run.failed}\n`);
  process.stdout.write(`  accuracy    ${Math.round(run.accuracy * 1000) / 10}%\n`);
  const failures = run.cases.filter((c) => !c.passed);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const c of failures.slice(0, 20)) {
      process.stdout.write(
        `  ✗ task="${truncateTask(c.task)}"  expected=${c.expected}  actual=${c.actual}\n`,
      );
    }
    if (failures.length > 20) {
      process.stdout.write(`  … (${failures.length - 20} more)\n`);
    }
  }
  return run.failed === 0 ? 0 : 1;
}

function truncateTask(s: string): string {
  if (s.length <= 60) return s;
  return s.slice(0, 57) + '…';
}

function runContextBenchmarkSeed(cwd: string, args: ParsedArgs): number {
  const wantJson = flagBool(args, 'json');
  const force = flagBool(args, 'force');
  const target = nodePath.join(cwd, 'sharkcraft', 'intent-benchmark.json');
  if (existsSync(target) && !force) {
    const msg = `${target} already exists. Use --force to overwrite.\n`;
    if (wantJson) {
      process.stdout.write(
        asJson({ ok: false, error: 'exists', path: target }) + '\n',
      );
      return 1;
    }
    process.stderr.write(msg);
    return 1;
  }
  mkdirSync(nodePath.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(STARTER_INTENT_BENCHMARK, null, 2), 'utf8');
  if (wantJson) {
    process.stdout.write(
      asJson({
        ok: true,
        wrote: target,
        cases: STARTER_INTENT_BENCHMARK.cases.length,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    `Seeded ${STARTER_INTENT_BENCHMARK.cases.length} starter intent case(s) → ${target}\n`,
  );
  process.stdout.write('Run `shrk context benchmark` to record accuracy.\n');
  return 0;
}
