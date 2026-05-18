/**
 * Registration hint.
 *
 * A registration hint describes a downstream registration step that a
 * generated construct typically needs (e.g. "register the new plugin in the
 * composer", "wire the new event into the route table"). Packs contribute
 * hints; the engine ships none.
 *
 * Hints are read-only data. The engine never auto-applies them — it can
 * preview them via `shrk registrations preview <hintId>` and link them
 * to templates via `template.metadata.registrationHintIds`.
 *
 * Discovery rules:
 *   - `discovery.targetFile` is a fixed relative path the hint applies to
 *     when present. If absent, `discovery.targetGlobs` lists candidate paths.
 *   - When more than one candidate matches, the hint MUST report
 *     `requiresHumanReview: true` and emit a conflict instead of guessing.
 */

export interface IRegistrationHintDiscovery {
  /** Fixed relative path inside the project root, when known. */
  readonly targetFile?: string;
  /** Glob patterns (relative paths). Used when the target file varies. */
  readonly targetGlobs?: readonly string[];
  /** Convention id(s) the target must satisfy (used as filter). */
  readonly conventionIds?: readonly string[];
  /** Profile ids the hint applies to (e.g. lifecycle profile). */
  readonly profileIds?: readonly string[];
}

export type RegistrationHintOpKind =
  | 'ensure-import'
  | 'insert-enum-entry'
  | 'insert-object-entry'
  | 'insert-before-closing-brace'
  | 'insert-between-anchors'
  | 'insert-after'
  | 'insert-before'
  | 'append'
  | 'export';

export interface IRegistrationHintOperation {
  readonly kind: RegistrationHintOpKind;
  /** Anchor literal used by anchor-based ops. */
  readonly anchor?: string;
  /** Begin anchor for insert-between-anchors. */
  readonly beginAnchor?: string;
  /** End anchor for insert-between-anchors. */
  readonly endAnchor?: string;
  /** Container name (interface / class / enum / object literal) for body ops. */
  readonly containerName?: string;
  /** Enum identifier for insert-enum-entry. */
  readonly enumName?: string;
  /** Object literal identifier for insert-object-entry. */
  readonly objectName?: string;
  /** Snippet body. May contain `{{var}}` placeholders. */
  readonly snippet?: string;
  /** Idempotency marker. */
  readonly ifMissing?: string;
  /** Find text (replace op). */
  readonly find?: string;
  /** Replace text (replace op). */
  readonly replaceWith?: string;
  /** Symbols (ensure-import / export). */
  readonly symbols?: readonly string[];
  /** Module specifier (ensure-import / export). */
  readonly from?: string;
}

export interface IRegistrationHint {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /**
   * Variables the hint snippet references (templated via `{{var}}`). When a
   * `preview` is requested, the engine substitutes these values.
   */
  readonly variables?: ReadonlyArray<{
    readonly name: string;
    readonly required: boolean;
    readonly description?: string;
    readonly defaultValue?: string;
  }>;
  readonly discovery: IRegistrationHintDiscovery;
  /**
   * The operations that the hint would perform if applied. Today the engine
   * surfaces these as a *preview* only.
   */
  readonly operations: ReadonlyArray<IRegistrationHintOperation>;
  /** When true, the preview must include a "requires human review" badge. */
  readonly requiresHumanReview?: boolean;
  /** Validation commands recommended after the human applies the hint. */
  readonly validationCommands?: readonly string[];
  /** Optional explanatory text shown alongside the preview. */
  readonly explanation?: string;
  /** Safety notes shown before any preview. */
  readonly safetyNotes?: readonly string[];
  readonly tags?: readonly string[];
}

export interface IRegistrationHintValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface IRegistrationHintValidationResult {
  readonly valid: boolean;
  readonly issues: readonly IRegistrationHintValidationIssue[];
}

export function validateRegistrationHint(value: unknown): IRegistrationHintValidationResult {
  const issues: IRegistrationHintValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: [{ field: '<root>', message: 'hint must be an object' }] };
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) issues.push({ field: 'id', message: 'id required' });
  if (typeof o.title !== 'string' || o.title.length === 0) issues.push({ field: 'title', message: 'title required' });
  if (!o.discovery || typeof o.discovery !== 'object') {
    issues.push({ field: 'discovery', message: 'discovery required' });
  } else {
    const d = o.discovery as Record<string, unknown>;
    const hasFixed = typeof d.targetFile === 'string' && d.targetFile.length > 0;
    const hasGlobs = Array.isArray(d.targetGlobs) && d.targetGlobs.length > 0;
    if (!hasFixed && !hasGlobs) {
      issues.push({
        field: 'discovery',
        message: 'discovery requires either targetFile or targetGlobs[]',
      });
    }
  }
  if (!Array.isArray(o.operations) || o.operations.length === 0) {
    issues.push({ field: 'operations', message: 'operations[] must be non-empty' });
  }
  return { valid: issues.length === 0, issues };
}
