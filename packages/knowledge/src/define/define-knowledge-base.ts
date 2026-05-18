import type { IKnowledgeBaseDefinition } from '../model/knowledge-base.ts';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';

export function defineKnowledgeBase(input: {
  name?: string;
  entries: readonly IKnowledgeEntry[];
}): IKnowledgeBaseDefinition {
  return { name: input.name, entries: Object.freeze([...input.entries]) };
}
