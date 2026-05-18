import { KnowledgeIndex, KnowledgeType, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IPathConvention } from './path-convention.ts';
import type { IPathQuery } from './path-query.ts';
import { selectBestPath, type IPathSelection } from './path-selector.ts';

export class PathService {
  private readonly index: KnowledgeIndex;

  constructor(entries: readonly IKnowledgeEntry[]) {
    this.index = new KnowledgeIndex(entries);
  }

  list(): IPathConvention[] {
    return this.index
      .filter((e) => String(e.type) === KnowledgeType.Path)
      .map((e) => e as IPathConvention);
  }

  get(id: string): IPathConvention | null {
    const entry = this.index.get(id);
    if (!entry || String(entry.type) !== KnowledgeType.Path) return null;
    return entry as IPathConvention;
  }

  search(query: IPathQuery): IPathConvention[] {
    const results = this.index.search({
      query: query.query ?? query.task,
      types: [KnowledgeType.Path],
      scope: query.scope,
      tags: query.tags,
      appliesWhen: query.appliesWhen,
      limit: query.limit,
    });
    return results.map((r) => r.entry as IPathConvention);
  }

  findBestForTask(task: string): IPathSelection | null {
    return selectBestPath(this.list(), task);
  }
}
