export type BoundarySeverity = 'error' | 'warning' | 'info';

export interface IBoundaryRule {
  id: string;
  title: string;
  description?: string;
  severity?: BoundarySeverity;
  /**
   * Glob patterns describing which files the rule applies to. Matched against
   * the file path relative to the project root.
   */
  from: readonly string[];
  /**
   * Glob patterns describing imports that are forbidden from `from` files.
   * Matched against the literal import specifier.
   */
  forbiddenImports?: readonly string[];
  /**
   * Optional whitelist of allowed imports (when set, non-matching imports
   * also trigger the rule). Useful for "from X, only @x/y is allowed".
   */
  allowedImports?: readonly string[];
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  message?: string;
  suggestedFix?: string;
  relatedRules?: readonly string[];
  relatedPathConventions?: readonly string[];
}

export function defineBoundaryRule<T extends IBoundaryRule>(rule: T): T {
  return rule;
}

export interface IBoundaryRuleValidationIssue {
  field: string;
  message: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function validateBoundaryRule(value: unknown): {
  valid: boolean;
  issues: IBoundaryRuleValidationIssue[];
} {
  const issues: IBoundaryRuleValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return {
      valid: false,
      issues: [{ field: '<root>', message: 'rule must be an object' }],
    };
  }
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_PATTERN.test(r.id)) {
    issues.push({ field: 'id', message: 'id required, slug-style' });
  }
  if (typeof r.title !== 'string' || r.title.length === 0) {
    issues.push({ field: 'title', message: 'title required' });
  }
  if (!Array.isArray(r.from) || r.from.length === 0) {
    issues.push({ field: 'from', message: 'from must be a non-empty string array' });
  }
  if (!Array.isArray(r.forbiddenImports) && !Array.isArray(r.allowedImports)) {
    issues.push({
      field: 'forbiddenImports|allowedImports',
      message: 'either forbiddenImports or allowedImports must be set',
    });
  }
  return { valid: issues.length === 0, issues };
}
