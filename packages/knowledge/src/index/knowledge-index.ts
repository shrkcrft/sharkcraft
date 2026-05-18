import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type { IKnowledgeQuery } from '../model/knowledge-query.ts';
import type { IKnowledgeSearchResult } from '../model/knowledge-search-result.ts';
import { KnowledgePriority, priorityWeight } from '../model/knowledge-priority.ts';
import { scoreEntry } from './relevance-score.ts';

export class KnowledgeIndex {
  private readonly byId = new Map<string, IKnowledgeEntry>();
  private readonly all: IKnowledgeEntry[] = [];

  constructor(entries: readonly IKnowledgeEntry[] = []) {
    for (const e of entries) this.add(e);
  }

  add(entry: IKnowledgeEntry): void {
    if (this.byId.has(entry.id)) {
      // Keep the first definition; tolerate duplicates with a warning marker.
      const existing = this.byId.get(entry.id)!;
      if (existing.content !== entry.content || existing.title !== entry.title) {
        // Don't throw — multiple files may legitimately re-export.
      }
      return;
    }
    this.byId.set(entry.id, entry);
    this.all.push(entry);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): IKnowledgeEntry | null {
    return this.byId.get(id) ?? null;
  }

  list(): readonly IKnowledgeEntry[] {
    return this.all;
  }

  size(): number {
    return this.all.length;
  }

  filter(predicate: (entry: IKnowledgeEntry) => boolean): IKnowledgeEntry[] {
    return this.all.filter(predicate);
  }

  search(query: IKnowledgeQuery): IKnowledgeSearchResult[] {
    const minPriorityWeight = query.minPriority
      ? priorityWeight(query.minPriority as KnowledgePriority)
      : 0;

    const candidates = this.all.filter((e) => {
      if (query.types?.length && !query.types.includes(String(e.type))) return false;
      if (minPriorityWeight > 0 && priorityWeight(e.priority as KnowledgePriority) < minPriorityWeight) {
        return false;
      }
      return true;
    });

    const scored = candidates
      .map((entry) => {
        const { score, reasons } = scoreEntry(entry, query);
        return { entry, score, reasons } as IKnowledgeSearchResult;
      })
      .filter((r) => {
        if (query.query || query.appliesWhen?.length || query.scope?.length || query.tags?.length) {
          return r.score > 0 && r.reasons.length > 0;
        }
        return true;
      })
      .sort((a, b) => b.score - a.score);

    return query.limit && query.limit > 0 ? scored.slice(0, query.limit) : scored;
  }
}
