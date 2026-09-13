/**
 * Canonical agent task entrypoint.
 *
 * `prepareAgentTask` is the recommended first call an AI agent (or
 * MCP client) makes when it picks up a task. It bundles:
 *   - intent classification
 *   - relevant rules / paths / templates / playbooks / profiles / conventions
 *   - recommended CLI commands (inspection / generation / validation)
 *   - uncertainty signals
 *   - safety notes
 *   - next safe action
 *
 * Read-only. Never writes; never executes commands.
 */
import { buildTaskPacket } from './task-packet.ts';
import { listConventions } from './convention-registry.ts';
import { listTaskRoutingHints, explainTaskRouting } from './task-routing-hint-registry.ts';
import { buildUncertaintySummary } from './uncertainty.ts';
import { matchTerm, prepareTermQuery } from './match-terms.ts';
import { classifyQueryIntent } from './query-intent.ts';
import { QueryIntent } from './query-intent-kind.ts';
import { referenceIdExists, warmReferenceRegistries, type ReferenceKind } from './reference-registry.ts';
import {
  ROUTING_RECOMMENDS_CHANNEL_KEYS,
  ROUTING_RECOMMENDS_CHANNELS,
} from './routing-recommends-channels.ts';
import type { ITaskRoutingRecommends } from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const AGENT_TASK_PREP_SCHEMA = 'sharkcraft.agent-task-prep/v1';

export interface IAgentTaskPrepReport {
  readonly schema: typeof AGENT_TASK_PREP_SCHEMA;
  readonly generatedAt: string;
  readonly task: string;
  readonly intentHints: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
  readonly missingSignals: readonly string[];
  readonly primaryCommands: readonly string[];
  readonly inspectionCommands: readonly string[];
  readonly generationCommands: readonly string[];
  readonly validationCommands: readonly string[];
  readonly relevantProfiles: readonly { id: string; title: string }[];
  readonly relevantConventions: readonly { id: string; title: string }[];
  /** Matched routing hints, each with the channels it recommends. */
  readonly routingHints: readonly {
    id: string;
    title: string;
    reasons: readonly string[];
    recommends: Readonly<Partial<Record<keyof ITaskRoutingRecommends, readonly string[]>>>;
  }[];
  /**
   * Every NON-command asset the matched routing hints recommend (templates,
   * playbooks, pipelines, rules, path conventions, knowledge, policies, …) that
   * resolves in its registry, deduped, in hint-score order. Only
   * `recommends.commands` used to have a consumer; the other channels loaded,
   * validated, and reached nothing.
   */
  readonly recommendedAssets: readonly { kind: ReferenceKind; id: string; hintId: string }[];
  readonly safetyNotes: readonly string[];
  readonly nextSafeAction: string;
}

/** The channels a hint actually declares, copied — never the hint object itself. */
function recommendsSummary(
  recommends: ITaskRoutingRecommends | undefined,
): Partial<Record<keyof ITaskRoutingRecommends, readonly string[]>> {
  const out: Partial<Record<keyof ITaskRoutingRecommends, readonly string[]>> = {};
  for (const channel of ROUTING_RECOMMENDS_CHANNEL_KEYS) {
    const ids = recommends?.[channel];
    if (Array.isArray(ids) && ids.length > 0) out[channel] = [...ids];
  }
  return out;
}

export async function prepareAgentTask(
  inspection: ISharkcraftInspection,
  task: string,
): Promise<IAgentTaskPrepReport> {
  const packet = buildTaskPacket(inspection, task);
  const uncertaintyReport = buildUncertaintySummary(packet);
  const conventions = await listConventions(inspection);
  const routing = await explainTaskRouting(inspection, task);
  await listTaskRoutingHints(inspection); // warm cache
  // THE id resolver answers "does this recommended id exist?" — the same one
  // the self-config doctor probes these channels with.
  await warmReferenceRegistries(inspection);

  const recommendedAssets: { kind: ReferenceKind; id: string; hintId: string }[] = [];
  const seenAssets = new Set<string>();
  for (const match of routing) {
    for (const channel of ROUTING_RECOMMENDS_CHANNEL_KEYS) {
      const spec = ROUTING_RECOMMENDS_CHANNELS[channel];
      if (spec.kind === 'command') continue;
      for (const id of match.hint.recommends?.[channel] ?? []) {
        if (typeof id !== 'string' || !referenceIdExists(inspection, spec.kind, id)) continue;
        const key = `${spec.kind}:${id}`;
        if (seenAssets.has(key)) continue;
        seenAssets.add(key);
        recommendedAssets.push({ kind: spec.kind, id, hintId: match.hint.id });
      }
    }
  }

  const inspectionCommands: string[] = [
    `shrk context --task "${task}" --commands-first`,
    `shrk task "${task}"`,
    `shrk why ${routing[0]?.hint.id ?? '<id>'} --for-task "${task}"`,
    'shrk packs contributions',
    'shrk self-config doctor',
  ];
  const generationCommands: string[] = [
    `shrk gen <template-id> <name> --dry-run --save-plan /tmp/plan.json`,
  ];
  const validationCommands: string[] = [
    'shrk doctor',
    'shrk check boundaries --changed-only',
    'shrk test agent',
    'shrk self-config doctor',
  ];
  const primaryCommands: string[] = routing.flatMap((m) => m.hint.recommends.commands ?? []).slice(0, 5);

  // THE query-intent classifier and THE term matcher — this used to be a
  // fifth ad-hoc verb-regex set ("add" anywhere meant generate-code, so
  // "fix the bug the last add introduced" was create work).
  const queryIntent = classifyQueryIntent(task);
  const termQuery = prepareTermQuery(task);
  const intentHints: string[] = [];
  if (queryIntent.intent === QueryIntent.Refactor || matchTerm(termQuery, 'rename')) intentHints.push('refactor');
  if (matchTerm(termQuery, 'remove') || matchTerm(termQuery, 'delete')) intentHints.push('removal');
  if (queryIntent.createVerb !== undefined) intentHints.push('generate-code');

  return {
    schema: AGENT_TASK_PREP_SCHEMA,
    generatedAt: new Date().toISOString(),
    task,
    intentHints,
    confidence: uncertaintyReport.confidence,
    missingSignals: uncertaintyReport.uncertainty.map((s) => s.code),
    primaryCommands,
    inspectionCommands,
    generationCommands,
    validationCommands,
    relevantProfiles: [],
    relevantConventions: conventions.slice(0, 5).map((e) => ({ id: e.convention.id, title: e.convention.title })),
    routingHints: routing.slice(0, 5).map((m) => ({
      id: m.hint.id,
      title: m.hint.title,
      reasons: m.reasons,
      recommends: recommendsSummary(m.hint.recommends),
    })),
    recommendedAssets,
    safetyNotes: [
      'SharkCraft engine never auto-applies plans. The human runs `shrk apply --verify-signature`.',
      'MCP tools are read-only; every write happens via the CLI.',
      'Folder rename/delete plans default to manual checklist; pass `--emit-folder-ops` to opt into structured plan ops with strict safety gates.',
    ],
    nextSafeAction:
      'Inspect the recommended commands above before writing any code. Start with `shrk task "<task>" --commands-first` for the human-friendly summary.',
  };
}
