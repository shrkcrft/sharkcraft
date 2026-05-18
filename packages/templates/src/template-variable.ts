export interface ITemplateVariable {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
  pattern?: RegExp;
  /** Optional choices, e.g. ['ts', 'tsx']. */
  choices?: readonly string[];
  /** Example values to surface in help text and error messages. */
  examples?: readonly string[];
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

export function validateTemplateVariables(
  variables: readonly ITemplateVariable[],
  values: Readonly<TemplateVariableValues>,
): IVariableValidationResult {
  const issues: IVariableValidationIssue[] = [];
  const resolved: TemplateVariableValues = {};

  for (const v of variables) {
    let provided = values[v.name];
    if ((provided === undefined || provided === '') && v.default !== undefined) {
      provided = v.default;
    }
    if (provided === undefined || provided === '') {
      if (v.required) {
        issues.push({ variable: v.name, message: `Variable '${v.name}' is required` });
      }
      continue;
    }
    if (v.pattern && !v.pattern.test(provided)) {
      issues.push({
        variable: v.name,
        message: `Variable '${v.name}' does not match pattern ${v.pattern.source}`,
      });
      continue;
    }
    if (v.choices && !v.choices.includes(provided)) {
      issues.push({
        variable: v.name,
        message: `Variable '${v.name}' must be one of: ${v.choices.join(', ')}`,
      });
      continue;
    }
    resolved[v.name] = provided;
  }
  return { valid: issues.length === 0, issues, resolved };
}
