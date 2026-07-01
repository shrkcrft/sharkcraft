import type { IKnowledgeEntry, IKnowledgeExample, IKnowledgeSource } from '../model/knowledge-entry.ts';
import type { IActionHints } from '../model/action-hints.ts';
import { KnowledgePriority } from '../model/knowledge-priority.ts';
import { isValidKnowledgeId } from '@shrkcrft/core';

export interface DefineKnowledgeInput {
  id: string;
  title: string;
  type: string;
  priority?: string;
  scope?: readonly string[];
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  content: string;
  summary?: string;
  examples?: readonly IKnowledgeExample[];
  related?: readonly string[];
  source?: IKnowledgeSource;
  metadata?: Readonly<Record<string, unknown>>;
  actionHints?: IActionHints;
  /** Author opt-out: no actionable next step → excluded from hint-coverage. */
  noAction?: boolean;
}

export function defineKnowledgeEntry(input: DefineKnowledgeInput): IKnowledgeEntry {
  if (!input.id || typeof input.id !== 'string') {
    throw new Error(`defineKnowledgeEntry: 'id' is required (got ${String(input.id)})`);
  }
  if (!isValidKnowledgeId(input.id)) {
    throw new Error(
      `defineKnowledgeEntry: 'id' must match /^[a-z0-9]+([.-][a-z0-9]+)*$/ (got "${input.id}")`,
    );
  }
  if (!input.title) {
    throw new Error(`defineKnowledgeEntry: 'title' is required for ${input.id}`);
  }
  if (!input.type) {
    throw new Error(`defineKnowledgeEntry: 'type' is required for ${input.id}`);
  }
  if (typeof input.content !== 'string') {
    throw new Error(`defineKnowledgeEntry: 'content' is required for ${input.id}`);
  }

  return {
    id: input.id,
    title: input.title,
    type: input.type,
    priority: input.priority ?? KnowledgePriority.Medium,
    scope: Object.freeze([...(input.scope ?? [])]),
    tags: Object.freeze([...(input.tags ?? [])]),
    appliesWhen: Object.freeze([...(input.appliesWhen ?? [])]),
    content: input.content,
    summary: input.summary,
    examples: input.examples ? Object.freeze([...input.examples]) : undefined,
    related: input.related ? Object.freeze([...input.related]) : undefined,
    source: input.source,
    metadata: input.metadata,
    actionHints: input.actionHints,
    ...(input.noAction !== undefined ? { noAction: input.noAction } : {}),
  };
}
