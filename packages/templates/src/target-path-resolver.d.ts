import type { ITemplateDefinition } from './template-definition.ts';
import type { TemplateVariableValues } from './template-variable.ts';
export interface IResolvedTargetPath {
    rawPath: string;
    absolutePath: string;
    isInsideProject: boolean;
}
export declare function resolveTargetPath(template: ITemplateDefinition, values: TemplateVariableValues, projectRoot: string): IResolvedTargetPath | null;
//# sourceMappingURL=target-path-resolver.d.ts.map