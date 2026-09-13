import { KnowledgeType, type IKnowledgeEntry } from '@shrkcrft/knowledge';

/**
 * THE "is this knowledge entry a rule?" predicate.
 *
 * A rule is a knowledge entry with `type: 'rule'` — from any loader (TypeScript
 * or Markdown), local or pack. `shrk rules list` (RuleService) and the custom
 * checks registry (`shrk checks`) both read this one function, so the rules a
 * user sees listed are exactly the rules whose `metadata.checks[]` are scanned.
 * They used to be two private copies of the same comparison, agreeing only by
 * coincidence.
 */
export function isRuleEntry(entry: Pick<IKnowledgeEntry, 'type'>): boolean {
  return String(entry.type) === KnowledgeType.Rule;
}
