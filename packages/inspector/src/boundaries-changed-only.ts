/**
 * Changed-only boundary filter.
 *
 * The boundary engine itself is unchanged. This module takes the raw
 * violations list from `evaluateBoundaries` (or the polyglot equivalent) +
 * a set of changed files, and returns:
 *   - includedViolations:   violations whose origin file *or* the file that
 *                           introduces the import edge is in the changed set.
 *   - ignoredLegacyCount:   violations filtered out because no changed file
 *                           touches them.
 *   - ignoredLegacyByRule:  ignored counts grouped by ruleId.
 *   - changedFiles:         the resolved changed-file set (project-relative).
 *
 * The engine never changes the violation contents — only filters.
 */

import { resolve } from 'node:path';
import { getChangedFiles } from './git-helpers.ts';

export enum ChangedScopeMode {
  ChangedOnly = 'changed-only',
  Since = 'since',
  Staged = 'staged',
  Files = 'files',
}

export interface IChangedScopeOptions {
  /** Project root used to anchor relative paths. */
  projectRoot: string;
  /** When provided, `git diff <ref>` selects the changed file set. */
  since?: string;
  /** When true, only staged (index) files. */
  staged?: boolean;
  /** Explicit file list (project-relative, '/'-normalised). */
  files?: ReadonlyArray<string>;
  /** When true, include the unstaged working tree changes too. */
  includeWorktree?: boolean;
}

export interface IBoundaryLikeViolation {
  ruleId: string;
  /** Either `file` (TS engine) or `fromFile` (polyglot engine). */
  file?: string;
  fromFile?: string;
}

export interface IChangedScopeFilterResult<TViolation extends IBoundaryLikeViolation> {
  mode: ChangedScopeMode;
  changedFiles: ReadonlyArray<string>;
  includedViolations: ReadonlyArray<TViolation>;
  ignoredLegacyCount: number;
  ignoredLegacyByRule: Readonly<Record<string, number>>;
}

function normalisePath(input: string, projectRoot: string): string {
  if (!input) return input;
  if (input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
    const rel = resolve(input).replace(resolve(projectRoot), '').replace(/^[\\/]+/, '');
    return rel.split(/[\\/]/).join('/');
  }
  return input.split(/[\\/]/).join('/');
}

export function resolveChangedFiles(opts: IChangedScopeOptions): {
  mode: ChangedScopeMode;
  files: string[];
} {
  if (opts.files && opts.files.length > 0) {
    return {
      mode: ChangedScopeMode.Files,
      files: opts.files.map((f) => normalisePath(f, opts.projectRoot)),
    };
  }
  if (opts.staged) {
    const out = getChangedFiles(opts.projectRoot, { staged: true });
    return { mode: ChangedScopeMode.Staged, files: out };
  }
  if (opts.since !== undefined && opts.since.length > 0) {
    const out = getChangedFiles(opts.projectRoot, { since: opts.since });
    return { mode: ChangedScopeMode.Since, files: out };
  }
  // default: working tree + unstaged
  const out = getChangedFiles(opts.projectRoot, { includeWorktree: true });
  return { mode: ChangedScopeMode.ChangedOnly, files: out };
}

export function filterViolationsToChangedScope<TViolation extends IBoundaryLikeViolation>(
  violations: ReadonlyArray<TViolation>,
  opts: IChangedScopeOptions,
): IChangedScopeFilterResult<TViolation> {
  const { mode, files } = resolveChangedFiles(opts);
  const changedSet = new Set(files.map((f) => f.split(/[\\/]/).join('/')));
  const included: TViolation[] = [];
  const ignoredByRule: Record<string, number> = {};
  for (const v of violations) {
    const candidate = v.file ?? v.fromFile ?? '';
    const norm = normalisePath(candidate, opts.projectRoot);
    if (changedSet.has(norm)) {
      included.push(v);
      continue;
    }
    // Allow callers to pass changed-file paths with prefix differences.
    // Lightweight fuzzy match: a violation file ending with /<changed>
    // counts as introduced by that change too (rare path-tail case).
    const matched = [...changedSet].some(
      (cf) => cf.length > 0 && (norm === cf || norm.endsWith('/' + cf)),
    );
    if (matched) {
      included.push(v);
      continue;
    }
    ignoredByRule[v.ruleId] = (ignoredByRule[v.ruleId] ?? 0) + 1;
  }
  let ignoredLegacyCount = 0;
  for (const v of Object.values(ignoredByRule)) ignoredLegacyCount += v;
  return {
    mode,
    changedFiles: files,
    includedViolations: included,
    ignoredLegacyCount,
    ignoredLegacyByRule: ignoredByRule,
  };
}

export interface IChangedBoundaryReport {
  schema: 'sharkcraft.changed-boundary-report/v1';
  mode: ChangedScopeMode;
  changedFiles: ReadonlyArray<string>;
  totalViolations: number;
  includedViolations: ReadonlyArray<IBoundaryLikeViolation>;
  ignoredLegacyCount: number;
  ignoredLegacyByRule: Readonly<Record<string, number>>;
}

export function buildChangedBoundaryReport<TViolation extends IBoundaryLikeViolation>(
  violations: ReadonlyArray<TViolation>,
  opts: IChangedScopeOptions,
): IChangedBoundaryReport {
  const filtered = filterViolationsToChangedScope(violations, opts);
  return {
    schema: 'sharkcraft.changed-boundary-report/v1',
    mode: filtered.mode,
    changedFiles: filtered.changedFiles,
    totalViolations: violations.length,
    includedViolations: filtered.includedViolations,
    ignoredLegacyCount: filtered.ignoredLegacyCount,
    ignoredLegacyByRule: filtered.ignoredLegacyByRule,
  };
}
