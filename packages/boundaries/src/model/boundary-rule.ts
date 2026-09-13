import {
  ASSET_REFERENCE_KINDS,
  exemptionListProblem,
  globListProblem,
  isMarkerObject,
  normalizeUnitList,
  unitProblemsOf,
  type IAssetReference,
  type IUnitList,
  type IUnitMark,
} from '@shrkcrft/core';
import { importPatternDefect } from '../scan/import-pattern.ts';
import { BoundaryMarkableList } from './boundary-markable-list.ts';
import type { IBoundaryRuleInput } from './boundary-rule-input.ts';
import { boundaryRuleKeyProblems } from './boundary-rule-key-problems.ts';
import { boundaryRuleMarkerProblems } from './boundary-rule-marker-problems.ts';
import { boundaryUnitProblemIssue } from './boundary-unit-problem-issue.ts';

export type BoundarySeverity = 'error' | 'warning' | 'info';

/**
 * How a rule's `forbiddenImports` (and `exceptions[].target`) match a specifier
 * (round 11, 1.5):
 *
 *   - `package` (the default): a pattern with no `**` and no trailing `/` is a
 *     PACKAGE pattern — it matches the specifier and every subpath under it
 *     (`@scope/pkg` → `@scope/pkg/deep`, never `@scope/pkg-legacy`).
 *   - `exact`: the pattern is matched exactly as a glob — the entrypoint-only
 *     behaviour, for barrel-avoidance rules ("forbid `lodash`, allow
 *     `lodash/get`").
 *
 * `allowedImports` never takes package semantics: widening an allow-list is the
 * permissive direction, which would silently turn existing red into green.
 */
export type ForbiddenMatchMode = 'package' | 'exact';

/** Which half of the pattern language matched a forbidden import. */
export type BoundaryMatchKind = 'exact' | 'subpath';

/** Where a file sits relative to a rule's scope: governed, exempted, or outside. */
export type BoundaryScopeDecision = 'in' | 'exempt' | 'out';

/** One exemption glob, and which rule field it came from. */
export interface IBoundaryScopeExemption {
  readonly glob: string;
  /** `from-negation` = a `!`-prefixed `from` entry; `excludeTests` = the shorthand. */
  readonly origin: 'from-negation' | 'exemptFiles' | 'excludeTests';
}

/** A rule's normalised source-side scope. */
export interface IBoundaryRuleScope {
  /** `from` globs that INCLUDE files (every entry not starting with `!`). */
  readonly include: readonly string[];
  /** Every exemption glob (from `!` entries, `exemptFiles`, `excludeTests`). */
  readonly exempt: readonly string[];
  readonly exemptions: readonly IBoundaryScopeExemption[];
}

/**
 * One adjudicated edge a rule allows. It is safe to ship only because it can
 * rot loudly: an exception that no longer suppresses any real edge is a
 * `stale-exception` ERROR, so the list can never grow into permanent silent
 * width.
 */
export interface IBoundaryRuleException {
  /** File glob of the importing file, matched like `from`. */
  path: string;
  /**
   * Specifier pattern, matched with the rule's `forbiddenImports` semantics
   * (alias candidates included). So under the default package semantics a
   * bare target also excuses that package's SUBPATHS — `'@acme/sdk'` excuses
   * `'@acme/sdk/client'` too: an exception allows one (path, target) PAIR,
   * which may be more than one edge. Write the deepest subpath you mean;
   * `forbiddenMatch: 'exact'` makes targets exact too. Deliberate — a target
   * spelled like the forbidden pattern excuses exactly what that pattern flags
   * (pinned by r76-exception-target-semantics).
   */
  target: string;
  /** Why the edge is sanctioned. Required — an unexplained exception is not an adjudication. */
  reason: string;
}

export interface IBoundaryRule {
  id: string;
  title: string;
  description?: string;
  /** Unset means `error` — the evaluator enforces it so (see `boundaryRuleSeverity`). */
  severity?: BoundarySeverity;
  /**
   * Glob patterns describing which files the rule applies to. Matched against
   * the file path relative to the project root. An entry starting with `!` is
   * an exemption (same as `exemptFiles`).
   */
  from: readonly string[];
  /**
   * Import specifiers forbidden from `from` files. Matched against the literal
   * specifier AND its tsconfig-alias-resolved paths, with package semantics
   * unless `forbiddenMatch: 'exact'` (see {@link ForbiddenMatchMode}).
   */
  forbiddenImports?: readonly string[];
  /** See {@link ForbiddenMatchMode}. Default `package`. */
  forbiddenMatch?: ForbiddenMatchMode;
  /**
   * Optional whitelist of allowed imports (when set, non-matching imports
   * also trigger the rule). Useful for "from X, only @x/y is allowed". Exact
   * glob semantics — never widened to subpaths.
   */
  allowedImports?: readonly string[];
  /**
   * Whether a rule whose `from` globs match NO scanned file fails the run (`1`)
   * instead of being reported skipped (`2`). Default: `true` for `error`
   * rules — the gate planes' contract. A rule matching nothing enforced
   * nothing, whatever its neighbours did.
   */
  failOnEmpty?: boolean;
  /**
   * File globs subtracted from the source side. Exempt files are still scanned;
   * their violations are MARKED suppressed (`exempt-file`) and counted — never
   * silently dropped. An exemption glob matching none of the rule's files is a
   * dead unit.
   */
  exemptFiles?: readonly string[];
  /** Shorthand: exempt `**\/__tests__/**`, `**\/__mocks__/**`, `**\/*.spec.*`, `**\/*.test.*`. */
  excludeTests?: boolean;
  /** Adjudicated edges this rule allows — see {@link IBoundaryRuleException}. */
  exceptions?: readonly IBoundaryRuleException[];
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  message?: string;
  suggestedFix?: string;
  relatedRules?: readonly string[];
  relatedPathConventions?: readonly string[];
  /**
   * Verifiable pointers to what this rule is ABOUT (the directories and
   * packages its globs describe) — the same shape knowledge entries declare,
   * swept by the same `shrk knowledge stale-check`. An undeclared key used to be
   * tolerated and checked by nothing, which is worse than absent: it looks
   * policed.
   */
  references?: readonly IAssetReference[];
  /**
   * The rule's `expectEmpty` markers (round 13) — DERIVED by the loader
   * (`normalizeBoundaryRule`) from `{ pattern, expectEmpty: true, reason? }`
   * entries in `from` / `exemptFiles` / `forbiddenImports` / `allowedImports`,
   * each mark's `list` naming its list and its `packageName` stamped from the
   * contributing pack. The lists above stay plain strings. Never authored: an
   * authored rule is an {@link IBoundaryRuleInput}, and this key is refused on it.
   */
  expectEmptyUnits?: readonly IUnitMark[];
}

/** Type a boundary rule as authored — the four selector lists accept `{ pattern, expectEmpty: true, reason? }` entries. */
export function defineBoundaryRule<T extends IBoundaryRuleInput>(rule: T): T {
  return rule;
}

/** One pattern of a rule that can never change its verdict, and the forbidden pattern that makes it so. */
export interface IBoundaryPatternOverlap {
  readonly pattern: string;
  /** Its position in its list (`forbiddenImports` or `allowedImports`). */
  readonly index: number;
  /** The forbidden pattern that already covers every import it matches. */
  readonly by: string;
}

/** What `boundaryPatternOverlaps` proves about one rule's specifier lists (round 12, R12-5.3 / R12-5.6). */
export interface IBoundaryPatternOverlaps {
  /** `forbiddenImports` entries a KEPT sibling already covers — deleting every one never narrows the fence. */
  readonly redundantForbidden: readonly IBoundaryPatternOverlap[];
  /** `allowedImports` entries a forbidden entry covers — forbidden is checked first, so they never admit an import. */
  readonly shadowedAllowed: readonly IBoundaryPatternOverlap[];
}

export interface IBoundaryRuleValidationIssue {
  field: string;
  message: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SEVERITIES: readonly string[] = ['error', 'warning', 'info'];
const FORBIDDEN_MATCH_MODES: readonly string[] = ['package', 'exact'];

/** How a markable list may be written — named by every "must be a list" refusal. */
const LIST_ENTRY_SHAPE = 'strings, or { pattern, expectEmpty: true, reason? }';

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
  // Round 13 — a key that is not a rule field (a rule-level `expectEmpty` /
  // `allowDead` among them) used to load and be silently ignored.
  issues.push(...boundaryRuleKeyProblems(r));
  if (typeof r.id !== 'string' || !ID_PATTERN.test(r.id)) {
    issues.push({ field: 'id', message: 'id required, slug-style' });
  }
  if (typeof r.title !== 'string' || r.title.length === 0) {
    issues.push({ field: 'title', message: 'title required' });
  }
  // Round 13 — each markable list through core's ONE marker parser FIRST
  // (every malformed marker named `<list>[i]: …`); every existing string check
  // below then runs on the NORMALISED units, so `{ pattern: '!' }` is refused
  // exactly like `'!'` and a marked pattern gets the same defect check.
  const normalized = (field: BoundaryMarkableList): IUnitList | undefined => {
    const raw = r[field];
    if (!Array.isArray(raw)) return undefined;
    const n = normalizeUnitList(raw, field);
    if (!n.ok) {
      for (const problem of unitProblemsOf(n.error)) issues.push(boundaryUnitProblemIssue(problem, field));
      return undefined;
    }
    return n.value;
  };
  const from = normalized(BoundaryMarkableList.From);
  const forbidden = normalized(BoundaryMarkableList.ForbiddenImports);
  const allowed = normalized(BoundaryMarkableList.AllowedImports);
  const exempt = normalized(BoundaryMarkableList.ExemptFiles);
  if (!Array.isArray(r.from) || r.from.length === 0) {
    issues.push({ field: 'from', message: `from must be a non-empty array of globs (${LIST_ENTRY_SHAPE})` });
  } else if (from !== undefined) {
    // The one list-shape check, beside core's one `!` parser: a bare `!` (an
    // empty exemption, silently dropped before round 12), a `!!x`, or only
    // exemptions — each governs nothing, forever. On this plane `!` EXEMPTS.
    const problem = globListProblem(from.units, 'are exemptions');
    if (problem !== undefined) issues.push({ field: 'from', message: `from ${problem}` });
  }
  if (!Array.isArray(r.forbiddenImports) && !Array.isArray(r.allowedImports)) {
    issues.push({
      field: 'forbiddenImports|allowedImports',
      message: 'either forbiddenImports or allowedImports must be set',
    });
  }
  if (r.forbiddenImports !== undefined && !Array.isArray(r.forbiddenImports)) {
    issues.push({ field: 'forbiddenImports', message: `forbiddenImports must be an array of import patterns (${LIST_ENTRY_SHAPE})` });
  }
  if (r.allowedImports !== undefined && !Array.isArray(r.allowedImports)) {
    issues.push({ field: 'allowedImports', message: `allowedImports must be an array of import patterns (${LIST_ENTRY_SHAPE})` });
  }
  // R12-5.2 — a specifier pattern that cannot mean what it says (a `!`, an
  // empty pattern, a trailing `/` under package semantics) is an authoring
  // error: it used to load, match nothing its author meant, and let the gate
  // print ✓ over imports of the very package it named. The one predicate
  // (`importPatternDefect`) sits beside the matcher; `allowedImports` is always
  // matched exactly, targets take the rule's mode. A normalised list keeps each
  // entry at its index, so `[i]` names the authored entry.
  const patternMode: ForbiddenMatchMode = r.forbiddenMatch === 'exact' ? 'exact' : 'package';
  const checkPatterns = (field: BoundaryMarkableList, list: IUnitList | undefined, mode: ForbiddenMatchMode): void => {
    list?.units.forEach((pattern, i) => {
      const defect = importPatternDefect(pattern, mode);
      if (defect !== undefined) issues.push({ field: `${field}[${i}]`, message: `'${pattern}': ${defect}` });
    });
  };
  checkPatterns(BoundaryMarkableList.ForbiddenImports, forbidden, patternMode);
  checkPatterns(BoundaryMarkableList.AllowedImports, allowed, 'exact');
  // A marker on a pattern dead by its shape, and failOnEmpty: true over an
  // all-marked `from` — refused (DECISIONS §4).
  issues.push(
    ...boundaryRuleMarkerProblems({ from, forbiddenImports: forbidden, allowedImports: allowed }, patternMode, r.failOnEmpty),
  );
  if (r.severity !== undefined && (typeof r.severity !== 'string' || !SEVERITIES.includes(r.severity))) {
    issues.push({ field: 'severity', message: `severity must be one of ${SEVERITIES.join(', ')}` });
  }
  if (
    r.forbiddenMatch !== undefined &&
    (typeof r.forbiddenMatch !== 'string' || !FORBIDDEN_MATCH_MODES.includes(r.forbiddenMatch))
  ) {
    issues.push({
      field: 'forbiddenMatch',
      message: `forbiddenMatch must be one of ${FORBIDDEN_MATCH_MODES.join(', ')}`,
    });
  }
  if (r.failOnEmpty !== undefined && typeof r.failOnEmpty !== 'boolean') {
    issues.push({ field: 'failOnEmpty', message: 'failOnEmpty must be a boolean' });
  }
  if (r.excludeTests !== undefined && typeof r.excludeTests !== 'boolean') {
    issues.push({ field: 'excludeTests', message: 'excludeTests must be a boolean' });
  }
  if (r.exemptFiles !== undefined && !Array.isArray(r.exemptFiles)) {
    issues.push({ field: 'exemptFiles', message: `exemptFiles must be an array of globs (${LIST_ENTRY_SHAPE})` });
  } else if (exempt !== undefined) {
    const problem = exemptionListProblem(exempt.units);
    if (problem !== undefined) issues.push({ field: 'exemptFiles', message: `exemptFiles ${problem}` });
  }
  if (r.exceptions !== undefined) {
    if (!Array.isArray(r.exceptions)) {
      issues.push({ field: 'exceptions', message: 'exceptions must be an array of { path, target, reason }' });
    } else {
      r.exceptions.forEach((e, i) => {
        const ex = (e ?? {}) as Record<string, unknown>;
        for (const key of ['path', 'target', 'reason'] as const) {
          const v = ex[key];
          if (key === 'target' && isMarkerObject(v)) {
            // Round 13: an exception adjudicates a real edge; one written
            // ahead of its edge is width with nothing to adjudicate, and it
            // must rot loudly (stale-exception, exit 1) — never be waived.
            issues.push({
              field: `exceptions[${i}].target`,
              message: 'exceptions take no expectEmpty — a stale exception is an error by design',
            });
            continue;
          }
          if (typeof v !== 'string' || v.trim().length === 0) {
            issues.push({
              field: `exceptions[${i}].${key}`,
              message:
                key === 'reason'
                  ? 'an exception needs a non-empty reason — an unexplained exception is not an adjudication'
                  : `${key} must be a non-empty string`,
            });
          }
        }
        if (typeof ex.target === 'string' && ex.target.trim().length > 0) {
          const defect = importPatternDefect(ex.target, patternMode);
          if (defect !== undefined) {
            issues.push({ field: `exceptions[${i}].target`, message: `'${ex.target}': ${defect}` });
          }
        }
      });
    }
  }
  if (r.references !== undefined) {
    // Shape only — whether each target still resolves is the staleness
    // sweep's job (`shrk knowledge stale-check`), against the live tree.
    if (!Array.isArray(r.references)) {
      issues.push({ field: 'references', message: 'references must be an array of { kind, path | id | symbol }' });
    } else {
      r.references.forEach((ref, i) => {
        const kind = (ref as { kind?: unknown } | null)?.kind;
        if (typeof kind !== 'string' || !ASSET_REFERENCE_KINDS.includes(kind as never)) {
          issues.push({
            field: `references[${i}].kind`,
            message: `kind must be one of ${ASSET_REFERENCE_KINDS.join(', ')}`,
          });
        }
      });
    }
  }
  return { valid: issues.length === 0, issues };
}
