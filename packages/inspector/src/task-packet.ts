import { buildContext, type IContextResult } from '@shrkcrft/context';
import {
  aggregateActionHints,
  type IAggregatedActionHints,
  type IKnowledgeEntry,
} from '@shrkcrft/knowledge';
import type { IRule } from '@shrkcrft/rules';
// IPathConvention is a structural subtype of IKnowledgeEntry; we expose
// IKnowledgeEntry here so the ranker output can be reused without casts.
import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { IPresetRecommendation } from '@shrkcrft/presets';
import type { IPipelineDefinition } from '@shrkcrft/pipelines';
import { rankAll, type IRankedItem } from './task-ranker.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { buildProjectOverview, renderOverviewText } from './project-overview.ts';

export interface ITaskPacketRecommendedPipeline {
  pipelineId: string;
  reason: string;
}

export interface ITaskPacketSuggestedGen {
  templateId: string;
  templateName: string;
  /** Concrete `shrk gen` command with placeholders for missing vars. */
  dryRunCommand: string;
  /** Concrete `shrk apply` command suggestion. */
  applyCommand: string;
  /** Variables this template requires. */
  requiredVariables: readonly string[];
}

export interface ITaskPacket {
  task: string;
  /** Compact project overview text (same shape as `shrk inspect`). */
  projectOverview: string;
  /** Detected profile tags. */
  detectedProfiles: readonly string[];
  /** Top preset recommendations (informational). */
  presetRecommendations: IPresetRecommendation[];
  /** Selected pipelines (max 3). */
  recommendedPipelines: ITaskPacketRecommendedPipeline[];
  /** Token-budgeted context (rules / paths / templates relevant to the task). */
  context: IContextResult;
  /** Rules that match the task (uncapped list, separate from the context body). */
  relevantRules: readonly IRule[];
  /** Paths that match (as knowledge entries with type "path"). */
  relevantPaths: readonly IKnowledgeEntry[];
  /** Templates that match. */
  relevantTemplates: readonly ITemplateDefinition[];
  /** Aggregated action hints across the relevant entries. */
  actionHints: IAggregatedActionHints;
  /** MCP tools recommended for this task. */
  recommendedMcpTools: readonly string[];
  /** CLI commands recommended for this task. */
  recommendedCliCommands: readonly string[];
  /** Things the agent must not do. */
  forbiddenActions: readonly string[];
  /** Commands that should be run after the change. */
  verificationCommands: readonly string[];
  /** Step ids that require human review (sourced from recommended pipelines). */
  humanReviewPoints: readonly string[];
  /** Rough token estimate for the packet body. */
  tokenEstimate: number;
  /**
   * Ranking explanations per kind (only filled when buildTaskPacket is called
   * with `explainRanking: true`).
   */
  rankingReasons?: {
    rules?: readonly { id: string; score: number; reasons: readonly string[] }[];
    paths?: readonly { id: string; score: number; reasons: readonly string[] }[];
    templates?: readonly { id: string; score: number; reasons: readonly string[] }[];
    pipelines?: readonly { id: string; score: number; reasons: readonly string[] }[];
    presets?: readonly { id: string; score: number; reasons: readonly string[] }[];
  };
  /**
   * If a template is an obvious fit, concrete `shrk gen` + `shrk apply`
   * commands. Variables that aren't extractable from the task stay as
   * placeholders so the agent doesn't hallucinate values.
   */
  suggestedGen?: ITaskPacketSuggestedGen;
}

export interface IBuildTaskPacketOptions {
  /** Optional max tokens for the embedded context. Default: 3500. */
  maxTokens?: number;
  /** Optional scope override forwarded to buildContext. */
  scope?: readonly string[];
  /** When true, include per-kind ranking reasons in the packet. */
  explainRanking?: boolean;
}

function findPipelinesByTags(
  pipelines: readonly IPipelineDefinition[],
  ...tags: string[]
): IPipelineDefinition[] {
  return pipelines.filter((p) => p.tags?.some((t) => tags.includes(t.toLowerCase())));
}

function pickPipelines(
  pipelines: readonly IPipelineDefinition[],
  task: string,
): ITaskPacketRecommendedPipeline[] {
  const lower = task.toLowerCase();
  const out: ITaskPacketRecommendedPipeline[] = [];
  const featureLike = /\b(create|add|implement|generate|new|build)\b/.test(lower);
  const refactorLike = /\b(refactor|rewrite|migrate|extract)\b/.test(lower);
  const testLike = /\b(test|spec|coverage)\b/.test(lower);

  if (featureLike) {
    for (const p of findPipelinesByTags(pipelines, 'feature', 'generation')) {
      if (!out.some((o) => o.pipelineId === p.id)) {
        out.push({ pipelineId: p.id, reason: 'task looks like new feature work' });
      }
    }
  }
  if (refactorLike) {
    for (const p of findPipelinesByTags(pipelines, 'refactor', 'safe', 'generation')) {
      if (!out.some((o) => o.pipelineId === p.id)) {
        out.push({ pipelineId: p.id, reason: 'task looks like refactor work' });
      }
    }
  }
  if (testLike) {
    for (const p of findPipelinesByTags(pipelines, 'test')) {
      if (!out.some((o) => o.pipelineId === p.id)) {
        out.push({ pipelineId: p.id, reason: 'task mentions testing' });
      }
    }
  }
  // Fallback: context-only when nothing matched.
  if (out.length === 0) {
    for (const p of findPipelinesByTags(pipelines, 'context', 'safe')) {
      out.push({ pipelineId: p.id, reason: 'no obvious work type — start with context-only' });
    }
  }
  return out.slice(0, 3);
}

/**
 * Build a deterministic, AI-ready bundle for a single task. Pure orchestration
 * over the existing inspector services — no AI calls, no writes.
 */
export function buildTaskPacket(
  inspection: ISharkcraftInspection,
  task: string,
  options: IBuildTaskPacketOptions = {},
): ITaskPacket {
  const maxTokens = options.maxTokens ?? 3500;
  const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);
  const overviewText = renderOverviewText(overview);

  const contextResult = buildContext(inspection.knowledgeEntries, {
    task,
    maxTokens,
    ...(options.scope ? { scope: options.scope as string[] } : {}),
    projectOverview: overviewText,
  });

  // ── Deterministic ranker — replaces the old substring search ─────────
  const ranking = rankAll(inspection, task, 10);
  const relevantRules = ranking.rules.map((r) => r.item);
  const relevantPaths = ranking.paths.map((r) => r.item);
  const relevantTemplates = ranking.templates.map((r) => r.item);

  // Aggregate hints from the *ranked* knowledge so unrelated entries don't
  // leak into the action-hints surface.
  const hintCorpus: IKnowledgeEntry[] = [
    ...ranking.rules.slice(0, 8).map((r) => r.item),
    ...inspection.knowledgeEntries.filter(
      (e) => e.priority === 'critical' || e.priority === 'high',
    ),
  ];
  const actionHints = aggregateActionHints(hintCorpus);

  // Pipelines: prefer ranker output, then verb fallback for context-only.
  const rankedPipelines = ranking.pipelines.slice(0, 3).map((p) => ({
    pipelineId: p.item.id,
    reason: p.reasons.join('; ') || 'ranked match',
  }));
  const fallback =
    rankedPipelines.length > 0 ? rankedPipelines : pickPipelines(inspection.pipelineRegistry.list(), task);
  const recommendedPipelines = fallback;
  const humanReviewPoints: string[] = [];
  for (const r of recommendedPipelines) {
    const p = inspection.pipelineRegistry.get(r.pipelineId);
    if (!p) continue;
    for (const step of p.steps) {
      if (step.humanReview) humanReviewPoints.push(`${p.id}.${step.id}`);
    }
  }

  const presetRecommendations = ranking.presets.slice(0, 3).map((r) => ({
    preset: r.item,
    score: r.score,
    confidence: (r.score >= 15 ? 'high' : r.score >= 9 ? 'medium' : 'low') as
      | 'high'
      | 'medium'
      | 'low',
    reasons: r.reasons,
  }));

  const tokenEstimate =
    contextResult.totalTokens +
    Math.ceil(
      (actionHints.commands.length + actionHints.mcpTools.length + actionHints.verificationCommands.length) *
        4,
    );

  // Suggested generation command — only emitted when one template clearly
  // dominates the field AND the user's wording suggests creation work.
  let suggestedGen: ITaskPacketSuggestedGen | undefined;
  const top = ranking.templates[0];
  const runnerUp = ranking.templates[1];
  if (
    top &&
    /\b(create|add|implement|generate|new|build)\b/i.test(task) &&
    (!runnerUp || top.score - runnerUp.score >= 4)
  ) {
    const tpl = top.item;
    const required = (tpl.variables ?? [])
      .filter((v) => v.required)
      .map((v) => v.name);
    const varStr = required.map((n) => `--var ${n}=<${n}>`).join(' ');
    const namePlaceholder = '<name>';
    suggestedGen = {
      templateId: tpl.id,
      templateName: tpl.name,
      dryRunCommand:
        `shrk gen ${tpl.id} ${namePlaceholder}${varStr ? ' ' + varStr : ''} --dry-run --save-plan ./.sharkcraft/plans/${tpl.id}.json`,
      applyCommand:
        `shrk apply ./.sharkcraft/plans/${tpl.id}.json --verify-signature  # human-approved only`,
      requiredVariables: required,
    };
  }

  function makeReasons<T extends { id: string }>(
    items: readonly IRankedItem<T>[],
  ): { id: string; score: number; reasons: readonly string[] }[] {
    return items.slice(0, 5).map((r) => ({
      id: r.item.id,
      score: r.score,
      reasons: r.reasons,
    }));
  }

  const rankingReasons = options.explainRanking
    ? {
        rules: makeReasons(ranking.rules),
        paths: makeReasons(ranking.paths),
        templates: makeReasons(ranking.templates),
        pipelines: makeReasons(ranking.pipelines),
        presets: makeReasons(ranking.presets),
      }
    : undefined;

  const packet: ITaskPacket = {
    task,
    projectOverview: overviewText,
    detectedProfiles: inspection.workspace.profiles,
    presetRecommendations,
    recommendedPipelines,
    context: contextResult,
    relevantRules,
    relevantPaths,
    relevantTemplates,
    actionHints,
    recommendedMcpTools: actionHints.mcpTools.map((t) => t.tool),
    recommendedCliCommands: actionHints.commands.map((c) =>
      typeof c === 'string' ? c : c.command,
    ),
    forbiddenActions: actionHints.forbiddenActions,
    verificationCommands: actionHints.verificationCommands,
    humanReviewPoints,
    tokenEstimate,
  };
  if (rankingReasons) packet.rankingReasons = rankingReasons;
  if (suggestedGen) packet.suggestedGen = suggestedGen;
  return packet;
}
