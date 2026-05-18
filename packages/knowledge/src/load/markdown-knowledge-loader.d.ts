import type { ILoadedKnowledge, IKnowledgeLoader } from './knowledge-loader.ts';
export declare class MarkdownKnowledgeLoader implements IKnowledgeLoader {
    canLoad(filePath: string): boolean;
    load(filePath: string): Promise<ILoadedKnowledge>;
}
//# sourceMappingURL=markdown-knowledge-loader.d.ts.map