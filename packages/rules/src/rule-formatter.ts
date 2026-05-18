import { formatEntryCompact, formatEntryFull, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IRule } from './rule.ts';

export function formatRuleCompact(rule: IRule): string {
  return formatEntryCompact(rule);
}

export function formatRuleFull(rule: IRule, options: { includeExamples?: boolean } = {}): string {
  return formatEntryFull(rule, { includeExamples: options.includeExamples ?? true });
}

export function formatRulesForAi(rules: readonly IKnowledgeEntry[]): string {
  if (rules.length === 0) return 'No relevant rules found.';
  return rules
    .map((r, i) => `${i + 1}. [${r.id}] ${r.title}\n   ${r.content.trim()}`)
    .join('\n\n');
}
