/**
 * Task routing hint. Packs and local config contribute hints that bias
 * the engine's recommendations (`shrk task`, `shrk context`, `shrk recommend`,
 * `shrk coverage scaffolds`, `shrk why`) toward their playbooks / templates /
 * helpers / profiles / conventions without the engine hardcoding any
 * project-specific tokens.
 *
 * Static data only — no executable code.
 */

export interface ITaskRoutingMatch {
  readonly keywords?: readonly string[];
  readonly phrases?: readonly string[];
  readonly regexes?: readonly string[];
  readonly languages?: readonly string[];
  readonly fileGlobs?: readonly string[];
  readonly constructKinds?: readonly string[];
}

export interface ITaskRoutingRecommends {
  readonly commands?: readonly string[];
  readonly templates?: readonly string[];
  readonly playbooks?: readonly string[];
  readonly helpers?: readonly string[];
  readonly profiles?: readonly string[];
  readonly conventions?: readonly string[];
  readonly knowledge?: readonly string[];
  readonly policies?: readonly string[];
}

export interface ITaskRoutingHint {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly match: ITaskRoutingMatch;
  readonly recommends: ITaskRoutingRecommends;
  /** Tag-/id-level confidence boost (0..5). */
  readonly confidenceBoost?: number;
  readonly explanation?: string;
  readonly safetyNotes?: readonly string[];
  readonly tags?: readonly string[];
}

export interface ITaskRoutingHintValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface ITaskRoutingHintValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ITaskRoutingHintValidationIssue[];
}

export function validateTaskRoutingHint(value: unknown): ITaskRoutingHintValidationResult {
  const issues: ITaskRoutingHintValidationIssue[] = [];
  if (!value || typeof value !== 'object') {
    return { valid: false, issues: [{ field: '<root>', message: 'hint must be an object' }] };
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) {
    issues.push({ field: 'id', message: 'id required' });
  }
  if (typeof o.title !== 'string' || o.title.length === 0) {
    issues.push({ field: 'title', message: 'title required' });
  }
  if (!o.match || typeof o.match !== 'object') {
    issues.push({ field: 'match', message: 'match required' });
  }
  if (!o.recommends || typeof o.recommends !== 'object') {
    issues.push({ field: 'recommends', message: 'recommends required' });
  }
  return { valid: issues.length === 0, issues };
}
