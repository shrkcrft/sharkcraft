import { isValidKnowledgeId } from '@shrkcrft/core';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import { ALL_KNOWLEDGE_TYPES } from '../model/knowledge-type.ts';
import { KnowledgePriority } from '../model/knowledge-priority.ts';

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
    | 'invalid-priority';
  /** Affected entry id (or '?' if unknown). */
  entryId: string;
  /** Source file path if available. */
  source?: string;
  /** Human-readable message. */
  message: string;
  /** Severity hint. */
  severity: 'error' | 'warning';
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
 */
export function validateKnowledgeEntries(
  entries: readonly IKnowledgeEntry[],
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
        severity: 'error',
      });
      continue;
    }

    if (!isValidKnowledgeId(id)) {
      issues.push({
        code: 'invalid-id-format',
        entryId: id,
        source,
        message: `Entry id "${id}" does not match /^[a-z0-9]+([.-][a-z0-9]+)*$/`,
        severity: 'error',
      });
      continue;
    }

    if (!entry.title) {
      issues.push({
        code: 'missing-title',
        entryId: id,
        source,
        message: `Entry "${id}" is missing a title.`,
        severity: 'error',
      });
    }
    if (typeof entry.content !== 'string') {
      issues.push({
        code: 'missing-content',
        entryId: id,
        source,
        message: `Entry "${id}" is missing content.`,
        severity: 'error',
      });
    }
    if (!entry.type) {
      issues.push({
        code: 'missing-type',
        entryId: id,
        source,
        message: `Entry "${id}" is missing a type.`,
        severity: 'error',
      });
    } else if (!VALID_TYPES.has(String(entry.type)) && entry.type !== 'custom') {
      issues.push({
        code: 'invalid-type',
        entryId: id,
        source,
        message: `Entry "${id}" uses unknown type "${entry.type}". Use KnowledgeType or set type:'custom'.`,
        severity: 'warning',
      });
    }
    if (entry.priority && !VALID_PRIORITIES.has(String(entry.priority))) {
      issues.push({
        code: 'invalid-priority',
        entryId: id,
        source,
        message: `Entry "${id}" has invalid priority "${entry.priority}". Allowed: critical|high|medium|low.`,
        severity: 'error',
      });
    }

    if (seen.has(id)) {
      issues.push({
        code: 'duplicate-id',
        entryId: id,
        source,
        message: `Duplicate knowledge id "${id}" — first occurrence wins, later ones ignored.`,
        severity: 'warning',
      });
      continue;
    }
    seen.set(id, entry);
    uniqueEntries.push(entry);
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  return { valid: !hasErrors, issues, uniqueEntries };
}
