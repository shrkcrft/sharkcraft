import { DELEGATE_GROUNDING_IDS, DELEGATE_QUERY_IDS } from '@shrkcrft/core';
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
  // Patch recipe ids — the only valid targets for an analysis recipe's escalateTo.
  const patchRecipeIds = new Set(recipes.filter((r) => r.mode !== 'analysis').map((r) => r.id));
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

    // Analysis recipes are read-only + grounded — a different fence than patch.
    // They must name a known grounding report and must NOT carry any write-fence
    // field (guardrailGlobs / allowedOps / verificationIds). The two modes are
    // disjoint; mixing them is a category error.
    if (recipe.mode === 'analysis') {
      if (!recipe.groundedOn) {
        issues.push({
          field: `delegation.recipes[${recipe.id}].groundedOn`,
          message: `analysis recipe "${recipe.id}" must declare a groundedOn report (one of: ${DELEGATE_GROUNDING_IDS.join(', ')})`,
          severity: 'error',
        });
      } else if (!(DELEGATE_GROUNDING_IDS as readonly string[]).includes(recipe.groundedOn)) {
        issues.push({
          field: `delegation.recipes[${recipe.id}].groundedOn`,
          message: `unknown groundedOn "${recipe.groundedOn}" — must be one of: ${DELEGATE_GROUNDING_IDS.join(', ')}`,
          severity: 'error',
        });
      }
      for (const f of ['guardrailGlobs', 'allowedOps', 'verificationIds'] as const) {
        if (recipe[f] !== undefined) {
          issues.push({
            field: `delegation.recipes[${recipe.id}].${f}`,
            message: `analysis recipe "${recipe.id}" must not declare ${f} — analysis mode is read-only and never writes`,
            severity: 'error',
          });
        }
      }
      // The bounded query loop (Phase 3): every allowedQueries entry must be a
      // known read-only query. An unknown query would silently do nothing.
      for (const q of recipe.allowedQueries ?? []) {
        if (!(DELEGATE_QUERY_IDS as readonly string[]).includes(q)) {
          issues.push({
            field: `delegation.recipes[${recipe.id}].allowedQueries`,
            message: `unknown query "${q}" — must be one of: ${DELEGATE_QUERY_IDS.join(', ')}`,
            severity: 'error',
          });
        }
      }
      // Escalation (Phase 4): escalateTo must name an existing PATCH recipe — an
      // analysis recipe only ever escalates into the fenced patch write path.
      if (recipe.escalateTo !== undefined && !patchRecipeIds.has(recipe.escalateTo)) {
        issues.push({
          field: `delegation.recipes[${recipe.id}].escalateTo`,
          message: `escalateTo "${recipe.escalateTo}" must reference an existing patch recipe (available: ${[...patchRecipeIds].join(', ') || '(none)'})`,
          severity: 'error',
        });
      }
      continue; // patch checks below don't apply to analysis recipes
    }

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
