import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { defineKnowledgeEntry, KnowledgeType, type DefineKnowledgeInput } from '@shrkcrft/knowledge';

export type IRule = IKnowledgeEntry;

export type DefineRuleInput = Omit<DefineKnowledgeInput, 'type'> & { type?: string };

export function defineRule(input: DefineRuleInput): IRule {
  return defineKnowledgeEntry({
    ...input,
    type: input.type ?? KnowledgeType.Rule,
  });
}
