import {
  buildKnowledgeStaleReport,
  buildScaffoldCoverageReport,
  buildSpecList,
  buildTaskPacket,
  buildTemplateDriftReport,
  buildUncertaintySummary,
  decomposeTask,
  entrypointBanner,
  inspectSharkcraft,
  lintKnowledge,
  renderScaffoldCoverageMarkdown,
  renderUncertaintyText,
  runDoctor,
  type ITaskPacket,
} from '@shrkcrft/inspector';
import { SpecStatus } from '@shrkcrft/generator';
import {
  flagBool,
  flagNumber,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { buildTaskNextReport } from '../task-next/task-next-ranker.ts';

function compactTaskPacket(p: ITaskPacket): Record<string, unknown> {
  return {
    task: p.task,
    detectedProfiles: p.detectedProfiles,
    recommendedPipelines: p.recommendedPipelines,
    presetRecommendations: p.presetRecommendations.map((r) => ({
      id: r.preset.id,
      score: r.score,
      confidence: r.confidence,
    })),
    relevantRules: p.relevantRules.map((r) => ({ id: r.id, title: r.title })),
    relevantPaths: p.relevantPaths.map((r) => ({ id: r.id, title: r.title })),
    relevantTemplates: p.relevantTemplates.map((t) => ({ id: t.id, name: t.name })),
    recommendedMcpTools: p.recommendedMcpTools,
    recommendedCliCommands: p.recommendedCliCommands,
    forbiddenActions: p.forbiddenActions,
    verificationCommands: p.verificationCommands,
    humanReviewPoints: p.humanReviewPoints,
    tokenEstimate: p.tokenEstimate,
    contextTokens: p.context.totalTokens,
  };
}

/**
 * DX#1 — Minimal JSON shape for agent / skill consumption.
 *
 * The default `--json` emits the full packet (~18 keys). For planning
 * loops where the agent only reads rules / templates / verification
 * IDs / recommended commands, that's ~75% noise. The compact shape
 * below carries just the load-bearing fields. Agents that want the
 * full packet pass `--json` without `--compact`.
 *
 * The schema marker is intentionally distinct so consumers can tell
 * the two shapes apart at a glance.
 */
function minimalTaskPacket(p: ITaskPacket): Record<string, unknown> {
  return {
    schema: 'sharkcraft.task-packet/v1-compact',
    task: p.task,
    relevantRules: p.relevantRules.map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
    })),
    relevantTemplates: p.relevantTemplates.map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.appliesWhen.length > 0 ? { appliesWhen: t.appliesWhen } : {}),
    })),
    verificationCommands: p.verificationCommands,
    recommendedMcpTools: p.recommendedMcpTools,
    recommendedCliCommands: p.recommendedCliCommands,
  };
}

export const taskCommand: ICommandHandler = {
  name: 'task',
  description:
    'Build an AI-ready task packet: relevant context, action hints, recommended pipeline, templates, paths, verification commands. Pass `--next` to skip the packet and survey the workspace for the highest-leverage next action.',
  usage:
    'shrk [--cwd <dir>] task "<task>" [--max-tokens 4000] [--scope x,y] [--explain-ranking] [--json] [--compact]   OR   shrk task --next [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const positional = args.positional;
    // `--next` short-circuits the packet build. Survey doctor / lint /
    // drift / stale, propose ONE highest-leverage action with the runnable
    // command. Pure ranker over existing JSON outputs.
    if (flagBool(args, 'next')) {
      const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
      const [doctorRes, staleRes, driftRes] = await Promise.all([
        runDoctor(inspection),
        Promise.resolve(buildKnowledgeStaleReport(inspection)),
        Promise.resolve(buildTemplateDriftReport(inspection, {})),
      ]);
      const knowledgeLint = lintKnowledge(inspection.knowledgeEntries, {});
      const categories: Record<string, number> = {};
      for (const f of knowledgeLint.findings) {
        categories[f.category] = (categories[f.category] ?? 0) + 1;
      }
      // Surface implementing-but-unverified specs to the ranker.
      const specSummaries = buildSpecList(resolveCwd(args)).entries;
      const implementingUnverified = specSummaries
        .filter((s) => s.status === SpecStatus.Implementing && !s.hasVerification)
        .map((s) => ({ id: s.id, title: s.title }));
      const report = buildTaskNextReport({
        doctor: doctorRes,
        stale: staleRes,
        drift: driftRes,
        knowledgeLint: { categories },
        specs: { implementingUnverified },
      });
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(report) + '\n');
        return 0;
      }
      process.stdout.write(header('Task — next highest-leverage action'));
      if (!report.nextAction) {
        process.stdout.write('  No outstanding work. ✓\n');
        return 0;
      }
      const a = report.nextAction;
      process.stdout.write(`  kind:       ${a.kind}\n`);
      process.stdout.write(`  command:    ${a.command}\n`);
      process.stdout.write(`  reason:     ${a.reason}\n`);
      process.stdout.write(`  resolves:   ${a.resolves}\n`);
      process.stdout.write(`  auto-apply: ${a.autoApplyEligible ? 'yes (mechanically safe)' : 'no (review needed)'}\n`);
      if (report.secondary.length > 0) {
        process.stdout.write('\nThen consider:\n');
        for (const s of report.secondary) {
          process.stdout.write(`  • ${s.command} — ${s.reason}\n`);
        }
      }
      return 0;
    }
    if (positional[0] === 'decompose') {
      const task = positional.slice(1).join(' ').trim();
      if (!task) {
        process.stderr.write('Usage: shrk task decompose "<task>"\n');
        return 2;
      }
      const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
      const d = decomposeTask(inspection, task);
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(d) + '\n');
        return 0;
      }
      process.stdout.write(header(`Decompose: ${task}`));
      process.stdout.write(kv('verb', d.verb) + '\n');
      process.stdout.write(kv('domain hints', d.domainHints.join(', ') || '(none)') + '\n');
      process.stdout.write('Subtasks:\n');
      for (const s of d.subtasks) process.stdout.write(`  ${s.id.padEnd(14)} (${s.riskLevel}) ${s.title}\n`);
      process.stdout.write('Templates: ' + d.suggestedTemplateIds.join(', ') + '\n');
      return 0;
    }
    const task = positional.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: shrk task "<task>"\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const maxTokens = flagNumber(args, 'max-tokens') ?? 3500;
    const scope = flagList(args, 'scope');
    const explainRanking = flagBool(args, 'explain-ranking') || flagBool(args, 'json');
    const packet = buildTaskPacket(inspection, task, {
      maxTokens,
      ...(scope.length ? { scope } : {}),
      explainRanking,
    });

    // Uncertainty summary always computed; coverage gaps when requested.
    const uncertainty = buildUncertaintySummary(packet);
    const showCoverageGaps = flagBool(args, 'show-coverage-gaps');
    const coverage = showCoverageGaps
      ? await buildScaffoldCoverageReport(inspection, { task })
      : null;

    if (flagBool(args, 'json')) {
      // DX#1 — `--compact` emits a minimal shape for agent / skill
      // consumption (~25% of the bytes). The full shape stays the
      // default so existing consumers don't break.
      if (flagBool(args, 'compact')) {
        process.stdout.write(asJson(minimalTaskPacket(packet)) + '\n');
        return 0;
      }
      process.stdout.write(
        asJson({
          ...compactTaskPacket(packet),
          context: packet.context,
          rankingReasons: packet.rankingReasons ?? null,
          suggestedGen: packet.suggestedGen ?? null,
          uncertainty,
          ...(coverage ? { coverage } : {}),
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`Task packet: ${task}`));
    // Entrypoint banner so the operator sees this is the machine-json class.
    // The banner now carries the canonical-entrypoint pointer; the separate
    // NOTE has been folded into the banner to avoid spamming the output.
    process.stdout.write(`(${entrypointBanner('task')})\n\n`);
    process.stdout.write(kv('detected profiles', packet.detectedProfiles.join(', ') || '(none)') + '\n');
    process.stdout.write(
      kv('context tokens', `${packet.context.totalTokens} / ${packet.context.maxTokens}`) + '\n',
    );
    process.stdout.write(kv('total token est.', String(packet.tokenEstimate)) + '\n');

    // Commands-first summary at the top so the agent sees the action
    // path before the long context body. `--commands-first` collapses the
    // output to just commands + uncertainty.
    // Text mode defaults to commands-first; pass `--verbose` or
    // `--full` to print the full packet. JSON output is unchanged.
    const commandsFirst = flagBool(args, 'commands-first');
    const actionsOnly = flagBool(args, 'actions-only');
    const verbose = flagBool(args, 'verbose') || flagBool(args, 'full');
    if (packet.recommendedCliCommands.length > 0) {
      process.stdout.write('\nTop commands (command-first):\n');
      for (const c of packet.recommendedCliCommands.slice(0, 5)) {
        process.stdout.write(`  $ ${c}\n`);
      }
    }
    if (packet.suggestedGen) {
      process.stdout.write('\nSuggested generation:\n');
      process.stdout.write(`  $ ${packet.suggestedGen.dryRunCommand}\n`);
    }
    if (commandsFirst || actionsOnly || !verbose) {
      if (!verbose && !commandsFirst && !actionsOnly) {
        process.stdout.write(
          '\n(text mode is summary-only — pass --verbose for the full packet, --json for machine output.)\n',
        );
      }
      // Render uncertainty and stop — caller asked for action-only output.
      process.stdout.write('\n' + renderUncertaintyText(uncertainty) + '\n');
      return 0;
    }

    if (packet.recommendedPipelines.length) {
      process.stdout.write('\nRecommended pipelines:\n');
      for (const r of packet.recommendedPipelines) {
        process.stdout.write(`  • ${r.pipelineId} — ${r.reason}\n`);
      }
    }
    if (packet.presetRecommendations.length) {
      process.stdout.write('\nPreset recommendations (informational):\n');
      for (const r of packet.presetRecommendations) {
        process.stdout.write(
          `  • ${r.preset.id} (confidence=${r.confidence}, score=${r.score})\n`,
        );
      }
    }
    if (packet.relevantRules.length) {
      process.stdout.write('\nRelevant rules:\n');
      for (const r of packet.relevantRules.slice(0, 10)) {
        process.stdout.write(`  • ${r.id}  ${r.title}\n`);
      }
      if (packet.relevantRules.length > 10) {
        process.stdout.write(`  … (${packet.relevantRules.length - 10} more)\n`);
      }
    }
    if (packet.relevantPaths.length) {
      process.stdout.write('\nRelevant paths:\n');
      for (const p of packet.relevantPaths.slice(0, 6)) {
        process.stdout.write(`  • ${p.id}  ${p.title}\n`);
      }
    }
    if (packet.relevantTemplates.length) {
      process.stdout.write('\nRelevant templates:\n');
      for (const t of packet.relevantTemplates.slice(0, 6)) {
        process.stdout.write(`  • ${t.id}  ${t.name}\n`);
      }
    }
    if (packet.suggestedGen) {
      process.stdout.write('\nSuggested generation (dry-run first):\n');
      process.stdout.write(`  $ ${packet.suggestedGen.dryRunCommand}\n`);
      process.stdout.write(`  $ ${packet.suggestedGen.applyCommand}\n`);
      if (packet.suggestedGen.requiredVariables.length) {
        process.stdout.write(
          `  required vars: ${packet.suggestedGen.requiredVariables.join(', ')} — fill in or run \`shrk templates vars ${packet.suggestedGen.templateId}\` first.\n`,
        );
      }
    }
    if (packet.recommendedCliCommands.length) {
      process.stdout.write('\nCLI commands:\n');
      for (const c of packet.recommendedCliCommands) process.stdout.write(`  $ ${c}\n`);
    }
    if (packet.recommendedMcpTools.length) {
      process.stdout.write('\nMCP tools:\n');
      for (const t of packet.recommendedMcpTools) process.stdout.write(`  • ${t}\n`);
    }
    if (packet.forbiddenActions.length) {
      process.stdout.write('\nForbidden actions:\n');
      for (const f of packet.forbiddenActions) process.stdout.write(`  • ${f}\n`);
    }
    if (packet.verificationCommands.length) {
      process.stdout.write('\nVerification commands:\n');
      for (const v of packet.verificationCommands) process.stdout.write(`  $ ${v}\n`);
    }
    if (packet.humanReviewPoints.length) {
      process.stdout.write('\nHuman-review checkpoints:\n');
      for (const h of packet.humanReviewPoints) process.stdout.write(`  • ${h}\n`);
    }
    if (packet.rankingReasons && flagBool(args, 'explain-ranking')) {
      process.stdout.write('\nRanking explanations:\n');
      for (const [label, items] of [
        ['pipelines', packet.rankingReasons.pipelines],
        ['templates', packet.rankingReasons.templates],
        ['presets', packet.rankingReasons.presets],
        ['rules', packet.rankingReasons.rules],
        ['paths', packet.rankingReasons.paths],
      ] as const) {
        if (!items?.length) continue;
        process.stdout.write(`  ${label}:\n`);
        for (const r of items) {
          process.stdout.write(`    [${r.score}] ${r.id} — ${r.reasons.join('; ')}\n`);
        }
      }
    }

    process.stdout.write('\nContext body (token-budgeted):\n');
    process.stdout.write(packet.context.body + '\n');

    // Uncertainty footer.
    process.stdout.write('\n' + renderUncertaintyText(uncertainty) + '\n');
    if (coverage) {
      process.stdout.write('\n');
      process.stdout.write(renderScaffoldCoverageMarkdown(coverage));
    }
    return 0;
  },
};
