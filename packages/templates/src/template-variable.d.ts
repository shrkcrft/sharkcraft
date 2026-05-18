export interface ITemplateVariable {
    name: string;
    description?: string;
    required?: boolean;
    default?: string;
    pattern?: RegExp;
    /** Optional choices, e.g. ['ts', 'tsx']. */
    choices?: readonly string[];
}
export type TemplateVariableValues = Record<string, string>;
export interface IVariableValidationIssue {
    variable: string;
    message: string;
}
export interface IVariableValidationResult {
    valid: boolean;
    issues: IVariableValidationIssue[];
    resolved: TemplateVariableValues;
}
export declare function validateTemplateVariables(variables: readonly ITemplateVariable[], values: Readonly<TemplateVariableValues>): IVariableValidationResult;
//# sourceMappingURL=template-variable.d.ts.map