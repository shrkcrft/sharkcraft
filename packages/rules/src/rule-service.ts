import { KnowledgeIndex, KnowledgeType, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IRule } from './rule.ts';
import type { IRuleQuery } from './rule-query.ts';
import { isRuleEntry } from './is-rule-entry.ts';

export class RuleService {
  private readonly index: KnowledgeIndex;

  constructor(entries: readonly IKnowledgeEntry[]) {
    this.index = new KnowledgeIndex(entries);
  }

  list(): IRule[] {
    return this.index.filter((e) => isRuleEntry(e));
  }

  get(id: string): IRule | null {
    const entry = this.index.get(id);
    if (!entry || !isRuleEntry(entry)) return null;
    return entry;
  }

  search(query: IRuleQuery): IRule[] {
    const results = this.index.search({
      query: query.task,
      types: [KnowledgeType.Rule],
      scope: query.scope,
      tags: query.tags,
      appliesWhen: query.appliesWhen,
      minPriority: query.minPriority,
      limit: query.limit,
    });
    return results.map((r) => r.entry);
  }

  getRelevant(task: string, options: Partial<IRuleQuery> = {}): IRule[] {
    return this.search({ ...options, task, limit: options.limit ?? 10 });
  }
}
