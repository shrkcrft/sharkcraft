import type { ITemplateDefinition } from './template-definition.ts';
export declare class TemplateRegistry {
    private readonly byId;
    constructor(templates?: readonly ITemplateDefinition[]);
    register(template: ITemplateDefinition): void;
    get(id: string): ITemplateDefinition | null;
    has(id: string): boolean;
    list(): ITemplateDefinition[];
    search(query: string): ITemplateDefinition[];
}
//# sourceMappingURL=template-registry.d.ts.map