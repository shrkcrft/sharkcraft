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
import { globListProblem, nearestIds } from '@shrkcrft/core';
import { ConventionAppliesToFilter } from './convention-applies-to-filter.ts';

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

/**
 * Where a convention applies (round 15, 15.1: every filter is EVALUATED — only
 * `fileGlobs` used to be). ONE authority decides it for every surface —
 * `conventionApplicability` (`@shrkcrft/inspector`), read by `conventions
 * check`, the rule-graph bridge, MCP `prepare_agent_task` and the `conventions
 * list / get / explain` display.
 *
 * Semantics (the pack-compatibility precedent): within a filter ANY listed
 * value matches; EVERY declared filter must match; an absent or empty filter
 * imposes no constraint. A convention that does not apply is never evaluated —
 * `conventions check` prints it as not applicable, with the reason.
 *
 * The keys are a closed set ({@link ConventionAppliesToFilter}): any other key
 * is an ERROR with a did-you-mean, because a typo'd filter silently widened
 * the convention to every file.
 */
export interface IConventionAppliesTo {
  /**
   * PER FILE: the file's language, by extension — the vocabulary `shrk stats`
   * prints (`typescript` for `.ts/.tsx/.mts/.cts`, `javascript`, `python`, …).
   * An unknown id is an info `convention-language-missing` finding in the
   * self-config doctor.
   */
  readonly languages?: readonly string[];
  /**
   * WORKSPACE: detected framework ids — the `FrameworkId` vocabulary of
   * `@shrkcrft/workspace` (`angular`, `react`, `nextjs`, `nestjs`, …), matched
   * against `inspection.workspace.frameworks`. An unknown id is an info
   * `convention-framework-missing` finding in the self-config doctor.
   */
  readonly frameworks?: readonly string[];
  /**
   * PER FILE: project-relative globs through the boundaries matcher — `**`
   * spans zero or more segments (`src/**\/*.ts` matches `src/a.ts`), `?` one
   * character but never `/`, and a `!` entry SUBTRACTS from the list.
   */
  readonly fileGlobs?: readonly string[];
  /**
   * RESERVED — not evaluated: there is no deterministic file → construct-kind
   * authority. The loader warns (`appliesTo.constructKinds is reserved and not
   * evaluated — the convention applies regardless`).
   */
  readonly constructKinds?: readonly string[];
  /**
   * WORKSPACE: WorkspaceProfile ids (`has-typescript`, `is-library`, … — `shrk
   * profiles list --kind workspace`), matched against the DETECTED profiles
   * (`inspection.workspace.profiles`). Resolved by the self-config doctor too
   * (a typo is a `convention-profile-missing` finding with a did-you-mean).
   */
  readonly profileIds?: readonly string[];
}

export interface IConventionRule {
  readonly id: string;
  readonly description: string;
  /**
   * Optional regex every file in the convention's scope SHOULD match — tested
   * against the project-relative path, like {@link forbidMatch}. A file in
   * scope that does not match is a hit (round 15: it was validated and never
   * evaluated, so an `error` rule of only `expectMatch` could never fail).
   */
  readonly expectMatch?: string;
  /** Optional regex (project-relative path) a file in scope MUST NOT match — a match is a hit. */
  readonly forbidMatch?: string;
  /** Optional regex (project-relative path) a file in scope must match — a miss is a hit. */
  readonly filePattern?: string;
  /** Optional severity override for this rule (else parent severity). */
  readonly severity?: ConventionSeverity;
}

export interface IConventionExample {
  readonly description: string;
  readonly good?: readonly string[];
  readonly bad?: readonly string[];
}

/**
 * What a convention reference points at — a CLOSED set. `validateConvention`
 * rejects any other `kind` and names these values. It is deliberately not the
 * knowledge asset-reference vocabulary: a convention reference is a
 * `{ kind, value }` pointer (a doc, a knowledge or rule id), not a verifiable
 * `{ kind, path | id }` reference.
 */
export enum ConventionReferenceKind {
  File = 'file',
  Doc = 'doc',
  Command = 'command',
  Knowledge = 'knowledge',
  Rule = 'rule',
}

export interface IConventionReference {
  /** A {@link ConventionReferenceKind} value — plain string literals (`'file'`) keep type-checking. */
  readonly kind: `${ConventionReferenceKind}`;
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
  /** False when any ERROR issue was found — the registry drops the convention loudly. */
  readonly valid: boolean;
  /** Errors: a shape the engine cannot evaluate, or a closed-union value outside its set. */
  readonly issues: readonly IConventionValidationIssue[];
  /** Shape problems that do not stop the convention from loading (unknown keys, a missing rule id). */
  readonly warnings: readonly IConventionValidationIssue[];
}

/** The fields an {@link IConvention} declares — anything else is an unknown key. */
const CONVENTION_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'description',
  'kind',
  'appliesTo',
  'rules',
  'examples',
  'references',
  'severity',
  'tags',
]);

/** The list fields of {@link IConventionAppliesTo} — every key it may carry (a closed set). */
const APPLIES_TO_LIST_KEYS: readonly string[] = Object.values(ConventionAppliesToFilter);

/** The one reserved filter: loaded, warned about, never evaluated. */
const RESERVED_APPLIES_TO_WARNING =
  'appliesTo.constructKinds is reserved and not evaluated — the convention applies regardless';

/** The regex-typed fields of an {@link IConventionRule}. */
const RULE_PATTERN_KEYS = ['expectMatch', 'forbidMatch', 'filePattern'] as const;

function enumValues(e: Record<string, string>): readonly string[] {
  return Object.values(e);
}

function isStringList(v: unknown): boolean {
  return Array.isArray(v) && v.every((m) => typeof m === 'string');
}

/**
 * Validate a convention's SHAPE against its declared closed unions.
 *
 * ERRORS (the convention is dropped, loudly): a closed-union value outside its
 * set — `kind`, `severity`, a rule's `severity`, a reference's `kind` (each
 * message names the allowed values) — or a shape the checker cannot evaluate: a
 * rule that is not an object, a pattern that does not compile, a list field
 * that is not a list, an `appliesTo` key outside {@link ConventionAppliesToFilter}
 * (with a did-you-mean — round 15). An unenumerated severity could never fail
 * `conventions check` (only `error` fails it), so accepting one was a check that
 * cannot fail.
 *
 * WARNINGS (the convention still loads): an unknown top-level key, a rule
 * without a string `id` / `description`, a reference without a `value`, a
 * non-empty `appliesTo.constructKinds` (RESERVED — not evaluated).
 */
export function validateConvention(value: unknown): IConventionValidationResult {
  const issues: IConventionValidationIssue[] = [];
  const warnings: IConventionValidationIssue[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, issues: [{ field: '<root>', message: 'convention must be an object' }], warnings };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    issues.push({ field: 'id', message: 'id must be a non-empty string' });
  }
  if (typeof obj.title !== 'string' || obj.title.length === 0) {
    issues.push({ field: 'title', message: 'title must be a non-empty string' });
  }
  const kinds = enumValues(ConventionKind);
  if (typeof obj.kind !== 'string' || !kinds.includes(obj.kind)) {
    issues.push({ field: 'kind', message: `kind must be one of: ${kinds.join(', ')} (got ${JSON.stringify(obj.kind)})` });
  }
  const severities = enumValues(ConventionSeverity);
  if (typeof obj.severity !== 'string' || !severities.includes(obj.severity)) {
    issues.push({
      field: 'severity',
      message:
        `severity must be one of: ${severities.join(', ')} (got ${JSON.stringify(obj.severity)}) — ` +
        'any other value can never fail `shrk conventions check`',
    });
  }
  if (!Array.isArray(obj.rules)) {
    issues.push({ field: 'rules', message: 'rules must be an array' });
  } else {
    obj.rules.forEach((rule: unknown, i: number) => validateConventionRule(rule, `rules[${i}]`, severities, issues, warnings));
  }
  if (obj.references !== undefined) {
    if (!Array.isArray(obj.references)) {
      issues.push({ field: 'references', message: `references must be an array (got ${typeof obj.references})` });
    } else {
      obj.references.forEach((ref: unknown, i: number) => validateConventionReference(ref, `references[${i}]`, issues, warnings));
    }
  }
  if (obj.appliesTo !== undefined) {
    if (!obj.appliesTo || typeof obj.appliesTo !== 'object' || Array.isArray(obj.appliesTo)) {
      issues.push({ field: 'appliesTo', message: 'appliesTo must be an object' });
    } else {
      const at = obj.appliesTo as Record<string, unknown>;
      for (const key of APPLIES_TO_LIST_KEYS) {
        if (at[key] !== undefined && !isStringList(at[key])) {
          issues.push({ field: `appliesTo.${key}`, message: `appliesTo.${key} must be a list of strings` });
        }
      }
      // Round 15 (15.1): an unknown filter is an ERROR, never ignored — a typo'd
      // `fileGlob` made the convention apply to EVERY file with a clean doctor.
      for (const key of Object.keys(at)) {
        if (APPLIES_TO_LIST_KEYS.includes(key)) continue;
        // A case-only slip (`FileGlobs`) is the one typo the scorer skips as "the
        // same id" — name it first, as core's marker-entry-problems does.
        const sameLetters = APPLIES_TO_LIST_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
        const near = sameLetters ?? nearestIds(key, APPLIES_TO_LIST_KEYS, 1)[0]?.id;
        issues.push({
          field: `appliesTo.${key}`,
          message:
            `appliesTo.${key} is not an appliesTo filter (filters: ${APPLIES_TO_LIST_KEYS.join(', ')}) — ` +
            `an unknown filter would silently widen the convention's scope${near ? `; did you mean "${near}"?` : ''}`,
        });
      }
      // `!` subtracts through core's ONE glob-list parser — so a malformed list
      // (a bare `!`, `!!x`, negations only) is the load error it is on every
      // other plane, never a list that silently selects nothing.
      const fileGlobs = at[ConventionAppliesToFilter.FileGlobs];
      if (isStringList(fileGlobs)) {
        const problem = globListProblem(fileGlobs as string[]);
        if (problem !== undefined) {
          issues.push({ field: `appliesTo.${ConventionAppliesToFilter.FileGlobs}`, message: `appliesTo.fileGlobs ${problem}` });
        }
      }
      const constructKinds = at[ConventionAppliesToFilter.ConstructKinds];
      if (Array.isArray(constructKinds) && constructKinds.length > 0) {
        warnings.push({ field: `appliesTo.${ConventionAppliesToFilter.ConstructKinds}`, message: RESERVED_APPLIES_TO_WARNING });
      }
    }
  }
  for (const key of ['tags', 'examples'] as const) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) {
      warnings.push({ field: key, message: `${key} must be an array (got ${typeof obj[key]}) — ignored` });
    }
  }
  for (const key of Object.keys(obj)) {
    if (!CONVENTION_KEYS.has(key)) {
      warnings.push({
        field: key,
        message: `unknown key "${key}" is not a convention field and is ignored (fields: ${[...CONVENTION_KEYS].join(', ')})`,
      });
    }
  }
  return { valid: issues.length === 0, issues, warnings };
}

function validateConventionRule(
  rule: unknown,
  at: string,
  severities: readonly string[],
  issues: IConventionValidationIssue[],
  warnings: IConventionValidationIssue[],
): void {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    issues.push({ field: at, message: `${at} must be an object` });
    return;
  }
  const r = rule as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) {
    warnings.push({ field: `${at}.id`, message: `${at}.id should be a non-empty string — hits are reported by rule id` });
  }
  if (typeof r.description !== 'string') {
    warnings.push({ field: `${at}.description`, message: `${at}.description should be a string — hits print it` });
  }
  if (r.severity !== undefined && (typeof r.severity !== 'string' || !severities.includes(r.severity))) {
    issues.push({
      field: `${at}.severity`,
      message:
        `${at}.severity must be one of: ${severities.join(', ')} (got ${JSON.stringify(r.severity)}) — ` +
        'any other value can never fail `shrk conventions check`',
    });
  }
  for (const key of RULE_PATTERN_KEYS) {
    const pattern = r[key];
    if (pattern === undefined) continue;
    if (typeof pattern !== 'string') {
      issues.push({ field: `${at}.${key}`, message: `${at}.${key} must be a regex string` });
      continue;
    }
    try {
      new RegExp(pattern);
    } catch (e) {
      issues.push({ field: `${at}.${key}`, message: `${at}.${key} does not compile: ${(e as Error).message}` });
    }
  }
}

function validateConventionReference(
  ref: unknown,
  at: string,
  issues: IConventionValidationIssue[],
  warnings: IConventionValidationIssue[],
): void {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    issues.push({ field: at, message: `${at} must be an object { kind, value }` });
    return;
  }
  const r = ref as Record<string, unknown>;
  const kinds = enumValues(ConventionReferenceKind);
  if (typeof r.kind !== 'string' || !kinds.includes(r.kind)) {
    issues.push({
      field: `${at}.kind`,
      message: `${at}.kind ${JSON.stringify(r.kind)} is not a convention reference kind — expected one of: ${kinds.join(', ')}`,
    });
  }
  if (typeof r.value !== 'string' || r.value.trim().length === 0) {
    warnings.push({ field: `${at}.value`, message: `${at}.value should be a non-empty string — the reference points nowhere` });
  }
}
