import { type DefineKnowledgeInput, type IKnowledgeEntry } from '@shrkcrft/knowledge';
export interface IPathConvention extends IKnowledgeEntry {
    readonly metadata: Readonly<{
        path: string;
        description?: string;
    }> & Record<string, unknown>;
}
export type DefinePathConventionInput = Omit<DefineKnowledgeInput, 'type' | 'content'> & {
    /** The actual path (relative to project root). */
    path: string;
    /** Optional human description. Used as the entry content when no explicit content is given. */
    description?: string;
    /** Optional override for explicit content. */
    content?: string;
};
export declare function definePathConvention(input: DefinePathConventionInput): IPathConvention;
//# sourceMappingURL=path-convention.d.ts.map