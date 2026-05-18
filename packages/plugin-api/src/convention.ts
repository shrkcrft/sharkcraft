/**
 * Generic naming / path / barrel / layout convention.
 *
 * Packs and local config contribute conventions via `conventionFiles[]`.
 * The engine has zero built-in conventions; everything comes from
 * contributions.
 *
 * A convention is static data — no executable code. Rules describe
 * patterns to expect / forbid; the engine matches files against them.
 */

export enum ConventionKind {
  Path = 'path',
  Naming = 'naming',
  Barrel = 'barrel',
  Layout = 'layout',
  Command = 'command',
  Validation = 'validation',
  Ownership = 'ownership',
  Testing = 'testing',
  Release = 'release',
  Safety = 'safety',
}

export enum ConventionSeverity {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

export interface IConventionAppliesTo {
  readonly languages?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly fileGlobs?: readonly string[];
  readonly constructKinds?: readonly string[];
  readonly profileIds?: readonly string[];
}

export interface IConventionRule {
  readonly id: string;
  readonly description: string;
  /** Optional regex describing what *should* match. */
  readonly expectMatch?: string;
  /** Optional regex describing what *must not* match. */
  readonly forbidMatch?: string;
  /** Optional file-name pattern. */
  readonly filePattern?: string;
  /** Optional severity override for this rule (else parent severity). */
  readonly severity?: ConventionSeverity;
}

export interface IConventionExample {
  readonly description: string;
  readonly good?: readonly string[];
  readonly bad?: readonly string[];
}

export interface IConventionReference {
  readonly kind: 'file' | 'doc' | 'command' | 'knowledge' | 'rule';
  readonly value: string;
}

export interface IConvention {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: ConventionKind;
  readonly appliesTo?: IConventionAppliesTo;
  readonly rules: readonly IConventionRule[];
  readonly examples?: readonly IConventionExample[];
  readonly references?: readonly IConventionReference[];
  readonly severity: ConventionSeverity;
  readonly tags?: readonly string[];
}

export interface IConventionValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface IConventionValidationResult {
  readonly valid: boolean;
  readonly issues: readonly IConventionValidationIssue[];
}

export function validateConvention(value: unknown): IConventionValidationResult {
  const issues: IConventionValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: [{ field: '<root>', message: 'convention must be an object' }] };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    issues.push({ field: 'id', message: 'id must be a non-empty string' });
  }
  if (typeof obj.title !== 'string' || obj.title.length === 0) {
    issues.push({ field: 'title', message: 'title must be a non-empty string' });
  }
  const knownKinds = new Set(Object.values(ConventionKind) as readonly string[]);
  if (typeof obj.kind !== 'string' || !knownKinds.has(obj.kind as string)) {
    issues.push({ field: 'kind', message: 'kind must be one of ConventionKind' });
  }
  if (!Array.isArray(obj.rules)) {
    issues.push({ field: 'rules', message: 'rules must be an array' });
  }
  return { valid: issues.length === 0, issues };
}
