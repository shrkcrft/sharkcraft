import type { ISharkCraftConfig } from './sharkcraft-config.ts';

export interface ConfigValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ConfigValidationResult {
  valid: boolean;
  issues: ConfigValidationIssue[];
}

export function validateConfig(config: ISharkCraftConfig): ConfigValidationResult {
  // Defensive: a malformed config file can deserialize to null / a non-object.
  // Report it as a single root error instead of throwing on `config.<field>`.
  if (config === null || typeof config !== 'object') {
    return {
      valid: false,
      issues: [{ field: '<root>', message: 'config must be an object', severity: 'error' }],
    };
  }

  const issues: ConfigValidationIssue[] = [];

  if (config.defaultMaxTokens !== undefined && config.defaultMaxTokens <= 0) {
    issues.push({
      field: 'defaultMaxTokens',
      message: 'defaultMaxTokens must be > 0',
      severity: 'error',
    });
  }

  for (const field of ['knowledgeFiles', 'ruleFiles', 'pathFiles', 'templateFiles', 'docsFiles'] as const) {
    const v = config[field];
    if (v !== undefined && !Array.isArray(v)) {
      issues.push({ field, message: `${field} must be an array of strings`, severity: 'error' });
    }
  }

  if (config.projectName !== undefined && typeof config.projectName !== 'string') {
    issues.push({ field: 'projectName', message: 'projectName must be a string', severity: 'error' });
  }

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}
