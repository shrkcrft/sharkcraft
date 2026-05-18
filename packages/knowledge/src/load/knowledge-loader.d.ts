import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
export interface ILoadedKnowledge {
    entries: IKnowledgeEntry[];
    warnings: string[];
    sourceFiles: string[];
}
export interface IKnowledgeLoader {
    load(filePath: string): Promise<ILoadedKnowledge>;
    canLoad(filePath: string): boolean;
}
//# sourceMappingURL=knowledge-loader.d.ts.map