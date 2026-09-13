import {
  isValidKnowledgeId,
  SCAN_ZONES,
  validateWiringSource,
  type IWiringSource,
} from '@shrkcrft/core';
import {
  KNOWLEDGE_REFERENCE_KINDS,
  type IKnowledgeEntry,
  type IKnowledgeReference,
} from '../model/knowledge-entry.ts';
import { ALL_KNOWLEDGE_TYPES } from '../model/knowledge-type.ts';
import { KnowledgePriority } from '../model/knowledge-priority.ts';
import { declaredAnchorItems } from '../model/knowledge-anchors.ts';
import { declaredReferenceItems } from '../model/knowledge-references.ts';
import { knowledgeSourceFormat } from '../model/knowledge-source-format-of.ts';
import { isValidVerifiedOn } from '../verify/verified-on.ts';
import { anchorShapeProblem, anchorsListProblem } from './anchor-shape-problem.ts';
import { referenceShapeProblem, referencesListProblem } from './reference-shape-problem.ts';
import { referenceRootProblem } from './reference-root-problem.ts';
import type { IKnowledgeValidationOptions } from './i-knowledge-validation-options.ts';
import { KnowledgeIssueSeverity } from './knowledge-issue-severity.ts';

export interface IKnowledgeValidationIssue {
  /** Stable identifier for the issue category. */
  code:
    | 'missing-id'
    | 'invalid-id-format'
    | 'duplicate-id'
    | 'missing-title'
    | 'missing-content'
    | 'missing-type'
    | 'invalid-type'
    | 'invalid-priority'
    /** A reference with an unknown kind, a missing required field, or a field its kind cannot carry. */
    | 'invalid-reference'
    /**
     * A non-list `anchors` value, or an anchor item that is not an object (or
     * holds a non-string `path` / `symbol` / `targetId`). The entry is kept —
     * the stale-check crashed on it (round 15 review).
     */
    | 'invalid-anchor'
    /**
     * A reference `path` written absolute (`/src/a.ts`, `C:\\src\\a.ts`).
     * Reference paths are repo-relative; the stale-check resolves the leading
     * slash away today, so it still passes — the warning keeps that leniency
     * from becoming a portability bug.
     */
    | 'reference-absolute-path'
    /** A reference `matches` pattern that does not compile. */
    | 'invalid-reference-pattern'
    /** A reference `count` whose `expected`, `measure` or `source` is malformed. */
    | 'invalid-reference-count'
    /** A `verifiedOn` that is not a real `YYYY-MM-DD` date. */
    | 'invalid-verified-on'
    /**
     * A malformed `supersededBy` / `seeAlso` / `related` (not a list of string
     * ids), or an entry that supersedes itself. EXISTENCE of each id is not
     * checked here — this layer cannot see the other registries; the declared
     * cross-reference collector (`shrk self-config doctor`) resolves them.
     */
    | 'invalid-cross-reference';
  /** Affected entry id (or '?' if unknown). */
  entryId: string;
  /** Source file path if available. */
  source?: string;
  /** Human-readable message. */
  message: string;
  /** Severity hint — THE knowledge-issue enum, shared with `IReferenceRootProblem` (round 15 lane B, B3). */
  severity: KnowledgeIssueSeverity;
}

export interface IKnowledgeValidationResult {
  valid: boolean;
  issues: IKnowledgeValidationIssue[];
  /** Entries with the first-seen winner for each id (duplicates dropped). */
  uniqueEntries: IKnowledgeEntry[];
}

const VALID_PRIORITIES = new Set<string>(Object.values(KnowledgePriority));
const VALID_TYPES = new Set<string>(ALL_KNOWLEDGE_TYPES);

/**
 * Validate a list of knowledge entries. Catches the classic problems:
 *   - missing or malformed id
 *   - duplicate ids (warning — first occurrence wins)
 *   - missing title/content/type
 *   - unknown type (warning — custom types are allowed but get flagged)
 *   - unknown priority (error)
 *   - a reference `root: pack` on an entry no pack contributes (error —
 *     `options.isPackContributed` is the provenance; round 15 follow-up)
 */
export function validateKnowledgeEntries(
  entries: readonly IKnowledgeEntry[],
  options: IKnowledgeValidationOptions = {},
): IKnowledgeValidationResult {
  const issues: IKnowledgeValidationIssue[] = [];
  const seen = new Map<string, IKnowledgeEntry>();
  const uniqueEntries: IKnowledgeEntry[] = [];

  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    const source = entry.source?.origin;

    if (!id) {
      issues.push({
        code: 'missing-id',
        entryId: '?',
        source,
        message: 'Knowledge entry is missing an `id`.',
        severity: KnowledgeIssueSeverity.Error,
      });
      continue;
    }

    if (!isValidKnowledgeId(id)) {
      issues.push({
        code: 'invalid-id-format',
        entryId: id,
        source,
        message: `Entry id "${id}" does not match /^[a-z0-9]+([.-][a-z0-9]+)*$/`,
        severity: KnowledgeIssueSeverity.Error,
      });
      continue;
    }

    if (!entry.title) {
      issues.push({
        code: 'missing-title',
        entryId: id,
        source,
        message: `Entry "${id}" is missing a title.`,
        severity: KnowledgeIssueSeverity.Error,
      });
    }
    if (typeof entry.content !== 'string') {
      issues.push({
        code: 'missing-content',
        entryId: id,
        source,
        message: `Entry "${id}" is missing content.`,
        severity: KnowledgeIssueSeverity.Error,
      });
    }
    if (!entry.type) {
      issues.push({
        code: 'missing-type',
        entryId: id,
        source,
        message: `Entry "${id}" is missing a type.`,
        severity: KnowledgeIssueSeverity.Error,
      });
    } else if (!VALID_TYPES.has(String(entry.type)) && entry.type !== 'custom') {
      issues.push({
        code: 'invalid-type',
        entryId: id,
        source,
        message: `Entry "${id}" uses unknown type "${entry.type}". Use KnowledgeType or set type:'custom'.`,
        severity: KnowledgeIssueSeverity.Warning,
      });
    }
    if (entry.priority && !VALID_PRIORITIES.has(String(entry.priority))) {
      issues.push({
        code: 'invalid-priority',
        entryId: id,
        source,
        message: `Entry "${id}" has invalid priority "${entry.priority}". Allowed: critical|high|medium|low.`,
        severity: KnowledgeIssueSeverity.Error,
      });
    }
    if (entry.verifiedOn !== undefined && !isValidVerifiedOn(entry.verifiedOn)) {
      issues.push({
        code: 'invalid-verified-on',
        entryId: id,
        source,
        message: `Entry "${id}" has verifiedOn "${String(entry.verifiedOn)}" — expected a real YYYY-MM-DD date.`,
        severity: KnowledgeIssueSeverity.Error,
      });
    }
    // A non-list `references` (TypeScript or Markdown) is an issue that KEEPS the
    // entry — `.forEach` on it crashed here and took every inspection-backed
    // verb down with it, a pack's entry included (round 15).
    const listProblem = referencesListProblem(entry.references, knowledgeSourceFormat(entry));
    if (listProblem) {
      issues.push({
        code: 'invalid-reference',
        entryId: id,
        source,
        message: `Entry "${id}" ${listProblem}.`,
        severity: KnowledgeIssueSeverity.Error,
      });
    }
    // EVERY declared item is judged — a string or a null is an issue, never skipped.
    const packContributed = options.isPackContributed?.(entry) === true;
    declaredReferenceItems(entry).forEach((ref, index) => {
      for (const found of validateReference(ref as IKnowledgeReference, index, packContributed)) {
        issues.push({ ...found, entryId: id, source, message: `Entry "${id}" ${found.message}` });
      }
    });
    // The same for `anchors` (round 15 review): a non-list value or a malformed
    // item is an issue that KEEPS the entry — `(entry.anchors ?? [])` crashed
    // the stale-check, `knowledge anchors` and `ide symbol` on it.
    const anchorsProblem = anchorsListProblem(entry.anchors);
    if (anchorsProblem) {
      issues.push({
        code: 'invalid-anchor',
        entryId: id,
        source,
        message: `Entry "${id}" ${anchorsProblem}.`,
        severity: KnowledgeIssueSeverity.Error,
      });
    }
    declaredAnchorItems(entry).forEach((anchor, index) => {
      const shape = anchorShapeProblem(anchor);
      if (shape) {
        issues.push({
          code: 'invalid-anchor',
          entryId: id,
          source,
          message: `Entry "${id}" anchor #${index + 1} ${shape}.`,
          severity: KnowledgeIssueSeverity.Error,
        });
      }
    });
    for (const found of validateCrossReferenceFields(entry, id)) {
      issues.push({ ...found, entryId: id, source, message: `Entry "${id}" ${found.message}` });
    }

    if (seen.has(id)) {
      issues.push({
        code: 'duplicate-id',
        entryId: id,
        source,
        message: `Duplicate knowledge id "${id}" — first occurrence wins, later ones ignored.`,
        severity: KnowledgeIssueSeverity.Warning,
      });
      continue;
    }
    seen.set(id, entry);
    uniqueEntries.push(entry);
  }

  const hasErrors = issues.some((i) => i.severity === KnowledgeIssueSeverity.Error);
  return { valid: !hasErrors, issues, uniqueEntries };
}

type IReferenceIssue = Pick<IKnowledgeValidationIssue, 'code' | 'message' | 'severity'>;

/**
 * The cross-reference id lists, with the severity of a malformed member and of
 * listing the entry's own id. `related` predates this check, so a bad member
 * there only warns; a self-reference in `related` is harmless and not flagged.
 */
const CROSS_REFERENCE_FIELDS: readonly {
  readonly field: 'supersededBy' | 'seeAlso' | 'related';
  readonly shape: KnowledgeIssueSeverity;
  readonly self?: { readonly severity: KnowledgeIssueSeverity; readonly why: string };
}[] = [
  {
    field: 'supersededBy',
    shape: KnowledgeIssueSeverity.Error,
    self: { severity: KnowledgeIssueSeverity.Error, why: 'an entry cannot replace itself' },
  },
  {
    field: 'seeAlso',
    shape: KnowledgeIssueSeverity.Error,
    self: { severity: KnowledgeIssueSeverity.Warning, why: 'it points the reader back at the entry they are reading' },
  },
  { field: 'related', shape: KnowledgeIssueSeverity.Warning },
];

/** Shape-only checks of the cross-reference lists (existence is the doctor's job). */
function validateCrossReferenceFields(entry: IKnowledgeEntry, id: string): IReferenceIssue[] {
  const out: IReferenceIssue[] = [];
  for (const spec of CROSS_REFERENCE_FIELDS) {
    const value = (entry as unknown as Record<string, unknown>)[spec.field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      out.push({
        code: 'invalid-cross-reference',
        severity: spec.shape,
        message: `\`${spec.field}\` must be a list of ids (got ${typeof value}).`,
      });
      continue;
    }
    const bad = value.filter((m) => typeof m !== 'string' || m.trim().length === 0).length;
    if (bad > 0) {
      out.push({
        code: 'invalid-cross-reference',
        severity: spec.shape,
        message: `\`${spec.field}\` has ${bad} member(s) that are not non-empty string ids.`,
      });
    }
    if (spec.self && value.includes(id)) {
      out.push({
        code: 'invalid-cross-reference',
        severity: spec.self.severity,
        message: `lists itself in \`${spec.field}\` — ${spec.self.why}.`,
      });
    }
  }
  return out;
}

const KNOWN_REFERENCE_KINDS = new Set<string>(KNOWLEDGE_REFERENCE_KINDS);
/** Kinds whose target has CONTENT a `contains` / `matches` can read. */
const CONTENT_KINDS = new Set<string>(['file', 'symbol']);
const COUNT_MEASURES = new Set<string>(['ids', 'sites']);
/** A leading `/` or `\`, optionally after a drive letter — never repo-relative. */
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:)?[\\/]+/;

/** The field a reference of this kind cannot be checked without, or undefined. */
function requiredFieldFor(ref: IKnowledgeReference): string | undefined {
  switch (ref.kind) {
    case 'file':
    case 'directory':
      return ref.path ? undefined : 'path';
    case 'symbol':
      return ref.symbol ? undefined : 'symbol';
    case 'command':
      return ref.id || ref.command ? undefined : 'id` or `command';
    case 'url':
      return undefined;
    default:
      return ref.id ? undefined : 'id';
  }
}

/**
 * Validate one reference's SHAPE — never whether its target exists; that is
 * the stale-check's job, against the live tree. A malformed reference used to
 * load silently and surface (if at all) as an `unknown` row, which reads as
 * "checked" to anyone skimming the counts.
 */
function validateReference(ref: IKnowledgeReference, index: number, packContributed = false): IReferenceIssue[] {
  const at = `reference #${index + 1}`;
  // THE item-shape predicate the stale-check applies too (a string, a number, a
  // non-string path), so a Markdown item and a TypeScript item fail alike.
  const shape = referenceShapeProblem(ref);
  if (shape) return [{ code: 'invalid-reference', severity: KnowledgeIssueSeverity.Error, message: `${at} ${shape}.` }];
  const kind = String((ref as { kind?: unknown }).kind);
  if (!KNOWN_REFERENCE_KINDS.has(kind)) {
    return [
      {
        code: 'invalid-reference',
        severity: KnowledgeIssueSeverity.Error,
        message: `${at} has unknown kind "${kind}" — expected one of: ${KNOWLEDGE_REFERENCE_KINDS.join(', ')}.`,
      },
    ];
  }
  const out: IReferenceIssue[] = [];
  const missing = requiredFieldFor(ref);
  if (missing) {
    out.push({
      code: 'invalid-reference',
      severity: KnowledgeIssueSeverity.Warning,
      message: `${at} (${kind}) has no \`${missing}\` — the stale-check cannot verify it.`,
    });
  }
  if (typeof ref.path === 'string' && ABSOLUTE_PATH_RE.test(ref.path)) {
    out.push({
      code: 'reference-absolute-path',
      severity: KnowledgeIssueSeverity.Warning,
      message:
        `${at} (${kind}) path "${ref.path}" is absolute — reference paths are repo-relative; ` +
        `write "${ref.path.replace(ABSOLUTE_PATH_RE, '')}".`,
    });
  }
  // THE `root` predicate the stale-check applies too (round 15 follow-up):
  // `root: pack` on a local entry is an error here and an INVALID row there.
  const rootProblem = referenceRootProblem(ref, packContributed);
  if (rootProblem) {
    out.push({ code: 'invalid-reference', severity: rootProblem.severity, message: `${at} (${kind}) ${rootProblem.message}.` });
  }
  const hasContent = ref.contains !== undefined || ref.matches !== undefined;
  if (hasContent && !CONTENT_KINDS.has(kind)) {
    out.push({
      code: 'invalid-reference',
      severity: KnowledgeIssueSeverity.Error,
      message:
        `${at} (${kind}) sets contains/matches, which apply to file and symbol references only` +
        (kind === 'directory' ? ' — assert on a directory with `count` instead.' : '.'),
    });
  }
  if (ref.contains !== undefined && (typeof ref.contains !== 'string' || ref.contains.length === 0)) {
    out.push({ code: 'invalid-reference', severity: KnowledgeIssueSeverity.Error, message: `${at} has an empty or non-string \`contains\`.` });
  }
  if (ref.matches !== undefined) {
    if (typeof ref.matches !== 'string' || ref.matches.length === 0) {
      out.push({
        code: 'invalid-reference-pattern',
        severity: KnowledgeIssueSeverity.Error,
        message: `${at} has an empty or non-string \`matches\`.`,
      });
    } else {
      try {
        new RegExp(ref.matches, 'm');
      } catch (e) {
        out.push({
          code: 'invalid-reference-pattern',
          severity: KnowledgeIssueSeverity.Error,
          message: `${at} \`matches\` does not compile: ${(e as Error).message}`,
        });
      }
    }
  }
  if (ref.scan !== undefined) {
    if (!SCAN_ZONES.includes(ref.scan)) {
      out.push({
        code: 'invalid-reference',
        severity: KnowledgeIssueSeverity.Error,
        message: `${at} has scan "${String(ref.scan)}" — expected one of: ${SCAN_ZONES.join(', ')}.`,
      });
    } else if (!hasContent) {
      out.push({
        code: 'invalid-reference',
        severity: KnowledgeIssueSeverity.Warning,
        message: `${at} sets \`scan\` without \`contains\` / \`matches\`, so it has no effect (a count zones through \`count.source.scan\`).`,
      });
    }
  }
  if (ref.count !== undefined) out.push(...validateReferenceCount(ref.count, at));
  return out;
}

function validateReferenceCount(count: unknown, at: string): IReferenceIssue[] {
  const issue = (message: string): IReferenceIssue => ({
    code: 'invalid-reference-count',
    severity: KnowledgeIssueSeverity.Error,
    message: `${at} ${message}`,
  });
  if (!count || typeof count !== 'object') {
    return [issue('`count` must be an object `{ source, expected, measure? }`.')];
  }
  const c = count as { source?: unknown; expected?: unknown; measure?: unknown };
  const out: IReferenceIssue[] = [];
  if (typeof c.expected !== 'number' || !Number.isInteger(c.expected) || c.expected < 0) {
    out.push(issue(`count.expected must be a non-negative integer (got ${JSON.stringify(c.expected)}).`));
  }
  if (c.measure !== undefined && !COUNT_MEASURES.has(String(c.measure))) {
    out.push(issue(`count.measure must be "ids" or "sites" (got ${JSON.stringify(c.measure)}).`));
  }
  if (!c.source || typeof c.source !== 'object') {
    out.push(issue('count.source must be an extraction-DSL source (`{ files, extract | pattern | arrayProperty, … }`).'));
  } else if ('$use' in (c.source as object)) {
    out.push(issue('count.source uses `$use`, which a knowledge reference does not resolve — inline the selector.'));
  } else {
    const problem = validateWiringSource(c.source as IWiringSource);
    if (problem) out.push(issue(`count.source ${problem}.`));
  }
  return out;
}
