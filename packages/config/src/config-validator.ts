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

  // Delegation: every recipe's verificationIds MUST resolve to a configured
  // verificationCommands[].id. This is the only way a delegate recipe runs a
  // verify command — a dangling id would silently un-gate a delegated edit, so
  // it is a hard error (and `shrk doctor` surfaces it).
  const knownVerificationIds = new Set(
    (config.verificationCommands ?? []).map((v) => v.id),
  );
  const recipes = config.delegation?.recipes ?? [];
  const seenRecipeIds = new Set<string>();
  for (const recipe of recipes) {
    if (seenRecipeIds.has(recipe.id)) {
      issues.push({
        field: `delegation.recipes[${recipe.id}]`,
        message: `duplicate delegate recipe id "${recipe.id}"`,
        severity: 'error',
      });
    }
    seenRecipeIds.add(recipe.id);
    if ((recipe.guardrailGlobs ?? []).length === 0) {
      issues.push({
        field: `delegation.recipes[${recipe.id}].guardrailGlobs`,
        message: `recipe "${recipe.id}" must declare at least one guardrail glob (a worker with no blast-radius fence is refused)`,
        severity: 'error',
      });
    }
    if ((recipe.allowedOps ?? []).length === 0) {
      issues.push({
        field: `delegation.recipes[${recipe.id}].allowedOps`,
        message: `recipe "${recipe.id}" must declare at least one allowed op`,
        severity: 'error',
      });
    }
    if ((recipe.verificationIds ?? []).length === 0) {
      issues.push({
        field: `delegation.recipes[${recipe.id}].verificationIds`,
        message: `recipe "${recipe.id}" must declare at least one verificationId — a delegate edit with no deterministic gate would apply unverified`,
        severity: 'error',
      });
    }
    for (const id of recipe.verificationIds ?? []) {
      if (!knownVerificationIds.has(id)) {
        issues.push({
          field: `delegation.recipes[${recipe.id}].verificationIds`,
          message: `unknown verification id "${id}" — define it in verificationCommands[] (a delegate recipe can only NAME a verification command, never inject one)`,
          severity: 'error',
        });
      }
    }
  }

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}
