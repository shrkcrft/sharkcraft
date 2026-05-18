/**
 * Changed-scope quality model v2.
 *
 * Generalised classification of any finding (boundary violation, policy
 * failure, drift entry, quality issue, doctor warning…) against a set of
 * changed files plus an optional baseline.
 *
 * Each finding falls into one of seven buckets:
 *
 *   new-in-changed-file        — finding lives in a changed file and was NOT
 *                                in the baseline.
 *   existing-touched           — finding exists in baseline AND the finding's
 *                                file is in the changed set.
 *   existing-untouched-hidden  — finding exists in baseline AND finding's file
 *                                is not changed; suppressed from the
 *                                "introduced by this change" view.
 *   resolved                   — finding existed in baseline but is no longer
 *                                present in the current result.
 *   unknown                    — finding has no file path, so we cannot bucket
 *                                it against changed files.
 *   unchanged                  — baseline and current both report this finding
 *                                in an unchanged file. Same as
 *                                existing-untouched-hidden but logically
 *                                preserved as "no change".
 *   out-of-scope               — finding lives outside any explicit scope the
 *                                caller passed (e.g. a non-relevant package).
 *
 * Inputs are pure data — this module does not run git, does not read files,
 * does not call out to language servers. Callers pre-compute the changed-file
 * set with `resolveChangedFiles` from `boundaries-changed-only.ts` (or pass
 * an explicit list), then feed everything in.
 *
 * Schema: sharkcraft.changed-scope/v1
 */

import { resolve } from 'node:path';

export const CHANGED_SCOPE_SCHEMA = 'sharkcraft.changed-scope/v1';

export enum ChangedFindingBucket {
  NewInChangedFile = 'new-in-changed-file',
  ExistingTouched = 'existing-touched',
  ExistingUntouchedHidden = 'existing-untouched-hidden',
  Resolved = 'resolved',
  Unknown = 'unknown',
  Unchanged = 'unchanged',
  OutOfScope = 'out-of-scope',
}

export interface IChangedScopeFinding {
  /**
   * Stable identity key: code + file + extra qualifier. Used to detect
   * whether the same finding existed in the baseline.
   */
  key: string;
  /** Optional file path the finding originates from. */
  file?: string;
  /** Optional ruleId / code category for grouping. */
  code?: string;
  /** Optional human-readable severity, surfaced verbatim. */
  severity?: string;
  /** Optional message for rendering. */
  message?: string;
  /** Arbitrary opaque payload preserved on the way through. */
  data?: Readonly<Record<string, unknown>>;
}

export interface IChangedScopeClassifyOptions {
  /** Project root for path normalisation (absolute → relative). */
  projectRoot: string;
  /** Current run findings. */
  current: ReadonlyArray<IChangedScopeFinding>;
  /** Optional baseline findings (same shape). */
  baseline?: ReadonlyArray<IChangedScopeFinding>;
  /** Changed-file set, project-relative ('/'-normalised). */
  changedFiles: ReadonlyArray<string>;
  /**
   * Optional explicit scope list. When set, files outside it become
   * `out-of-scope`. Empty list means "no scope restriction".
   */
  scopeFiles?: ReadonlyArray<string>;
}

export interface IChangedScopeClassifiedFinding {
  finding: IChangedScopeFinding;
  bucket: ChangedFindingBucket;
}

export interface IChangedScopeClassification {
  schema: typeof CHANGED_SCOPE_SCHEMA;
  changedFiles: ReadonlyArray<string>;
  classified: ReadonlyArray<IChangedScopeClassifiedFinding>;
  counts: {
    newInChangedFile: number;
    existingTouched: number;
    existingUntouchedHidden: number;
    resolved: number;
    unknown: number;
    unchanged: number;
    outOfScope: number;
  };
  /** Findings whose bucket is `new-in-changed-file` (most actionable). */
  newIssues: ReadonlyArray<IChangedScopeFinding>;
  /** Findings whose bucket is `existing-touched`. */
  existingTouched: ReadonlyArray<IChangedScopeFinding>;
  /**
   * Existing findings hidden from the headline view but still reachable
   * by callers that want them.
   */
  hiddenBaseline: ReadonlyArray<IChangedScopeFinding>;
  /** Findings that were in the baseline but no longer appear. */
  resolved: ReadonlyArray<IChangedScopeFinding>;
}

function normalisePath(input: string | undefined, projectRoot: string): string {
  if (!input) return '';
  if (input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
    const rel = resolve(input).replace(resolve(projectRoot), '').replace(/^[\\/]+/, '');
    return rel.split(/[\\/]/).join('/');
  }
  return input.split(/[\\/]/).join('/');
}

function isInSet(file: string, set: Set<string>): boolean {
  if (set.size === 0) return false;
  if (set.has(file)) return true;
  for (const candidate of set) {
    if (candidate && (file === candidate || file.endsWith('/' + candidate))) return true;
  }
  return false;
}

export function classifyChangedScope(
  opts: IChangedScopeClassifyOptions,
): IChangedScopeClassification {
  const changedSet = new Set(
    opts.changedFiles.map((f) => f.split(/[\\/]/).join('/')),
  );
  const scopeSet = new Set(
    (opts.scopeFiles ?? []).map((f) => f.split(/[\\/]/).join('/')),
  );
  const baselineKeys = new Set((opts.baseline ?? []).map((b) => b.key));
  const baselineByKey = new Map<string, IChangedScopeFinding>();
  for (const b of opts.baseline ?? []) baselineByKey.set(b.key, b);
  const currentKeys = new Set(opts.current.map((c) => c.key));

  const classified: IChangedScopeClassifiedFinding[] = [];
  const newIssues: IChangedScopeFinding[] = [];
  const existingTouched: IChangedScopeFinding[] = [];
  const hiddenBaseline: IChangedScopeFinding[] = [];
  const resolved: IChangedScopeFinding[] = [];

  for (const finding of opts.current) {
    const file = normalisePath(finding.file, opts.projectRoot);
    if (!file) {
      classified.push({ finding, bucket: ChangedFindingBucket.Unknown });
      continue;
    }
    if (scopeSet.size > 0 && !isInSet(file, scopeSet)) {
      classified.push({ finding, bucket: ChangedFindingBucket.OutOfScope });
      continue;
    }
    const inChanged = isInSet(file, changedSet);
    const inBaseline = baselineKeys.has(finding.key);
    if (inChanged && inBaseline) {
      classified.push({ finding, bucket: ChangedFindingBucket.ExistingTouched });
      existingTouched.push(finding);
      continue;
    }
    if (inChanged && !inBaseline) {
      classified.push({ finding, bucket: ChangedFindingBucket.NewInChangedFile });
      newIssues.push(finding);
      continue;
    }
    if (!inChanged && inBaseline) {
      classified.push({ finding, bucket: ChangedFindingBucket.Unchanged });
      hiddenBaseline.push(finding);
      continue;
    }
    // not in changed, not in baseline — pre-existing in untouched file.
    classified.push({ finding, bucket: ChangedFindingBucket.ExistingUntouchedHidden });
    hiddenBaseline.push(finding);
  }

  for (const b of opts.baseline ?? []) {
    if (!currentKeys.has(b.key)) {
      classified.push({ finding: b, bucket: ChangedFindingBucket.Resolved });
      resolved.push(b);
    }
  }

  const counts = {
    newInChangedFile: 0,
    existingTouched: 0,
    existingUntouchedHidden: 0,
    resolved: 0,
    unknown: 0,
    unchanged: 0,
    outOfScope: 0,
  };
  for (const c of classified) {
    switch (c.bucket) {
      case ChangedFindingBucket.NewInChangedFile:
        counts.newInChangedFile += 1;
        break;
      case ChangedFindingBucket.ExistingTouched:
        counts.existingTouched += 1;
        break;
      case ChangedFindingBucket.ExistingUntouchedHidden:
        counts.existingUntouchedHidden += 1;
        break;
      case ChangedFindingBucket.Resolved:
        counts.resolved += 1;
        break;
      case ChangedFindingBucket.Unknown:
        counts.unknown += 1;
        break;
      case ChangedFindingBucket.Unchanged:
        counts.unchanged += 1;
        break;
      case ChangedFindingBucket.OutOfScope:
        counts.outOfScope += 1;
        break;
    }
  }

  return {
    schema: CHANGED_SCOPE_SCHEMA,
    changedFiles: opts.changedFiles,
    classified,
    counts,
    newIssues,
    existingTouched,
    hiddenBaseline,
    resolved,
  };
}

/**
 * Convenience helper for callers that want the headline numbers in
 * one line of text.
 */
export function summariseChangedScope(
  classification: IChangedScopeClassification,
): string {
  const c = classification.counts;
  return (
    `New issues introduced: ${c.newInChangedFile} | ` +
    `Existing touched: ${c.existingTouched} | ` +
    `Existing hidden baseline: ${c.existingUntouchedHidden + c.unchanged} | ` +
    `Resolved: ${c.resolved}`
  );
}
