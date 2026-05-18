import type { ITemplateVariable, TemplateVariableValues } from './template-variable.ts';
export interface ITemplateFile {
    /** Final file path relative to project root. */
    targetPath: string;
    /** File contents. */
    content: string;
    /** Optional MIME or hint, e.g. "typescript". */
    language?: string;
    /** Default: false (do not overwrite if exists). */
    overwrite?: boolean;
}
export type TargetPathResolver = string | ((values: TemplateVariableValues) => string);
export type ContentResolver = string | ((values: TemplateVariableValues) => string);
export type FilesResolver = (values: TemplateVariableValues) => ITemplateFile[];
export interface ITemplateDefinition {
    id: string;
    name: string;
    description: string;
    tags: readonly string[];
    scope: readonly string[];
    appliesWhen: readonly string[];
    variables: readonly ITemplateVariable[];
    /** Single-file template: target path. */
    targetPath?: TargetPathResolver;
    /** Single-file template: content. */
    content?: ContentResolver;
    /** Multi-file template: file factory. */
    files?: FilesResolver;
    /** Post-generation notes shown to the user. */
    postGenerationNotes?: readonly string[];
    /** Related knowledge entry IDs. */
    related?: readonly string[];
}
export declare function defineTemplate(input: ITemplateDefinition): ITemplateDefinition;
//# sourceMappingURL=template-definition.d.ts.map