import { type IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IPathConvention } from './path-convention.ts';
import type { IPathQuery } from './path-query.ts';
import { type IPathSelection } from './path-selector.ts';
export declare class PathService {
    private readonly index;
    constructor(entries: readonly IKnowledgeEntry[]);
    list(): IPathConvention[];
    get(id: string): IPathConvention | null;
    search(query: IPathQuery): IPathConvention[];
    findBestForTask(task: string): IPathSelection | null;
}
//# sourceMappingURL=path-service.d.ts.map