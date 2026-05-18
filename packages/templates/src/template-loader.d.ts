import type { ITemplateDefinition } from './template-definition.ts';
export interface ILoadedTemplates {
    templates: ITemplateDefinition[];
    warnings: string[];
    sourceFiles: string[];
}
export declare function loadTemplatesFromFile(filePath: string): Promise<ILoadedTemplates>;
//# sourceMappingURL=template-loader.d.ts.map