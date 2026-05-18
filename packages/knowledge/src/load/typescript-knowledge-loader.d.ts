import type { ILoadedKnowledge, IKnowledgeLoader } from './knowledge-loader.ts';
export declare class TypeScriptKnowledgeLoader implements IKnowledgeLoader {
    canLoad(filePath: string): boolean;
    load(filePath: string): Promise<ILoadedKnowledge>;
}
//# sourceMappingURL=typescript-knowledge-loader.d.ts.map