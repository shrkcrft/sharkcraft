/**
 * Pack-contributed helper definition.
 *
 * Packs can ship project-specific helpers via `helperFiles[]`. Each helper is
 * static data — no executable pack code beyond declarative operations the
 * engine understands. The engine plans and previews; never auto-applies.
 */

export enum PackHelperOutputKind {
  Preview = 'preview',
  Plan = 'plan',
  Checklist = 'checklist',
}

export interface IPackHelperSafety {
  readonly readOnly?: boolean;
  readonly writesDrafts?: boolean;
  readonly writesSource?: boolean;
  readonly requiresProfile?: boolean;
  readonly requiresHumanReview?: boolean;
  readonly destructivePotential?: boolean;
  readonly outputKind: PackHelperOutputKind;
}

export interface IPackHelperVariable {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  readonly defaultValue?: string;
}

export interface IPackHelperOperationInput {
  readonly kind: 'append-line' | 'insert-before' | 'replace-line' | 'remove-line' | 'manual-checklist';
  readonly targetPath?: string;
  readonly anchor?: string;
  readonly snippet?: string;
  readonly find?: string;
  readonly replaceWith?: string;
  readonly checklist?: readonly string[];
  readonly description: string;
}

export interface IPackHelper {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly variables: readonly IPackHelperVariable[];
  /**
   * Declarative operation list. The engine renders these as plan v2 ops
   * (no arbitrary pack code execution). When `operations` is empty, the
   * helper acts as a checklist generator only.
   */
  readonly operations?: readonly IPackHelperOperationInput[];
  readonly manualChecklist?: readonly string[];
  readonly tags?: readonly string[];
  readonly appliesWhen?: readonly string[];
  readonly safety: IPackHelperSafety;
}

export interface IPackHelperValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface IPackHelperValidationResult {
  readonly valid: boolean;
  readonly issues: readonly IPackHelperValidationIssue[];
}

export function validatePackHelper(value: unknown): IPackHelperValidationResult {
  const issues: IPackHelperValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: [{ field: '<root>', message: 'helper must be an object' }] };
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) {
    issues.push({ field: 'id', message: 'id required' });
  }
  if (typeof o.title !== 'string' || o.title.length === 0) {
    issues.push({ field: 'title', message: 'title required' });
  }
  if (!Array.isArray(o.variables)) {
    issues.push({ field: 'variables', message: 'variables must be an array' });
  }
  const safety = o.safety as Record<string, unknown> | undefined;
  if (!safety || typeof safety !== 'object') {
    issues.push({ field: 'safety', message: 'safety required' });
  } else {
    const validOutput = new Set(['preview', 'plan', 'checklist']);
    if (typeof safety.outputKind !== 'string' || !validOutput.has(safety.outputKind as string)) {
      issues.push({ field: 'safety.outputKind', message: 'outputKind must be preview|plan|checklist' });
    }
  }
  return { valid: issues.length === 0, issues };
}
