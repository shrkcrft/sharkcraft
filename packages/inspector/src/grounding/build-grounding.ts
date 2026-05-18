/**
 * `shrk grounding "<task>"` data builder.
 *
 * Pure composition of `buildTaskPacket`'s output projected onto a
 * compact `sharkcraft.grounding/v1` shape. No new ranker, no LLM,
 * no shell-out. Read-only.
 *
 * The grounding view is what an external SDD skill / plugin asks
 * for when it needs to ground its plan against the live workspace —
 * rules, knowledge, paths, templates, predicted boundary risks,
 * trusted verification command IDs.
 */

import { searchKnowledge } from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildTaskPacket } from '../task-packet.ts';

export const GROUNDING_SCHEMA = 'sharkcraft.grounding/v1';

export interface IGroundingRule {
  readonly id: string;
  readonly title: string;
  readonly priority?: string;
}

export interface IGroundingKnowledge {
  readonly id: string;
  readonly title: string;
  readonly scope?: readonly string[];
  readonly summary?: string;
}

export interface IGroundingPath {
  readonly id: string;
  readonly title: string;
}

export interface IGroundingTemplate {
  readonly id: string;
  readonly name: string;
  readonly appliesWhen?: readonly string[];
}

export interface IGroundingReport {
  readonly schema: typeof GROUNDING_SCHEMA;
  readonly task: string;
  readonly generatedAt: string;
  readonly rules: readonly IGroundingRule[];
  readonly knowledge: readonly IGroundingKnowledge[];
  readonly paths: readonly IGroundingPath[];
  readonly templates: readonly IGroundingTemplate[];
  readonly verificationCommandIds: readonly string[];
  readonly recommendedMcpTools: readonly string[];
  readonly recommendedCliCommands: readonly string[];
  readonly tokenEstimate: number;
}

export interface IBuildGroundingOptions {
  readonly maxTokens?: number;
  readonly limit?: number;
}

export function buildGrounding(
  task: string,
  inspection: ISharkcraftInspection,
  options: IBuildGroundingOptions = {},
): IGroundingReport {
  const limit = options.limit ?? 5;
  const packet = buildTaskPacket(inspection, task, {
    maxTokens: options.maxTokens ?? 2500,
  });
  const trustedVerificationIds = (inspection.config?.verificationCommands ?? [])
    .filter((c) => c.trusted !== false)
    .map((c) => c.id);

  return {
    schema: GROUNDING_SCHEMA,
    task,
    generatedAt: new Date().toISOString(),
    rules: packet.relevantRules.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
    })),
    knowledge: searchKnowledge(inspection.knowledgeEntries, { query: task, limit })
      .map((hit) => ({
        id: hit.entry.id,
        title: hit.entry.title,
        ...(hit.entry.scope && hit.entry.scope.length > 0 ? { scope: hit.entry.scope } : {}),
        ...(hit.entry.summary ? { summary: hit.entry.summary } : {}),
      })),
    paths: packet.relevantPaths.slice(0, limit).map((p) => ({ id: p.id, title: p.title })),
    templates: packet.relevantTemplates.slice(0, limit).map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.appliesWhen.length > 0 ? { appliesWhen: t.appliesWhen } : {}),
    })),
    verificationCommandIds: trustedVerificationIds,
    recommendedMcpTools: packet.recommendedMcpTools.slice(0, limit),
    recommendedCliCommands: packet.recommendedCliCommands.slice(0, limit),
    tokenEstimate: packet.tokenEstimate,
  };
}
