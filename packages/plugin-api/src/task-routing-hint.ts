/**
 * Task routing hint. Packs and local config contribute hints that bias
 * the engine's recommendations (`shrk task`, `shrk context`, `shrk recommend`,
 * `shrk coverage scaffolds`, `shrk why`) toward their playbooks / templates /
 * helpers / profiles / conventions without the engine hardcoding any
 * project-specific tokens.
 *
 * Static data only — no executable code.
 */

import { TermMatchMode } from './term-match-mode.ts';

export interface ITaskRoutingMatch {
  /** Scored: +2 per keyword found in the task (see {@link ITaskRoutingMatch.mode}). */
  readonly keywords?: readonly string[];
  /** Scored: +3 per phrase found in the task (see {@link ITaskRoutingMatch.mode}). */
  readonly phrases?: readonly string[];
  /**
   * How `keywords` / `phrases` are matched. Default `tokens`: normalised term
   * sequences (`capability-pack` ≡ "capability pack"; `ci` never fires inside
   * `pricing`). `substring` is the legacy raw containment — opt in for infix
   * matching; the loader warns on a needle shorter than 4 characters there.
   * `regexes` are unaffected (a regex is already an explicit mode).
   */
  readonly mode?: TermMatchMode | `${TermMatchMode}`;
  /** Scored: +2 per case-insensitive regex that matches the task. */
  readonly regexes?: readonly string[];
  /**
   * RESERVED — not scored today: the matcher sees the task string only, not
   * its files or language. A hint declaring only `languages` / `fileGlobs` /
   * `constructKinds` can never match; the loader warns
   * (`unscored-match-criteria`).
   */
  readonly languages?: readonly string[];
  /** RESERVED — not scored today; see {@link ITaskRoutingMatch.languages}. */
  readonly fileGlobs?: readonly string[];
  /** RESERVED — not scored today; see {@link ITaskRoutingMatch.languages}. */
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
  /** Pipeline ids — probed by the self-config doctor, handed to agents by `prepare_agent_task`. */
  readonly pipelines?: readonly string[];
  /** Rule ids — probed by the self-config doctor, handed to agents by `prepare_agent_task`. */
  readonly rules?: readonly string[];
  /** Path-convention ids — probed by the self-config doctor, handed to agents by `prepare_agent_task`. */
  readonly paths?: readonly string[];
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
  } else {
    const m = o.match as Record<string, unknown>;
    const modes: readonly string[] = Object.values(TermMatchMode);
    if (m.mode !== undefined && (typeof m.mode !== 'string' || !modes.includes(m.mode))) {
      issues.push({ field: 'match.mode', message: `mode must be one of ${modes.join(' | ')}` });
    }
    for (const key of ['keywords', 'phrases', 'regexes'] as const) {
      const v = m[key];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
        issues.push({ field: `match.${key}`, message: `${key} must be an array of strings` });
      }
    }
  }
  if (!o.recommends || typeof o.recommends !== 'object') {
    issues.push({ field: 'recommends', message: 'recommends required' });
  }
  return { valid: issues.length === 0, issues };
}
