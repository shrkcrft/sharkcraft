import { describeEntryValue } from '@shrkcrft/core';

/**
 * Anchor fields the stale-check reads as strings — a list or a map there
 * reached a path join or a symbol lookup and crashed it.
 */
const STRING_FIELDS = ['path', 'symbol', 'targetId'] as const;

/**
 * Why one `anchors[]` item is not a well-typed anchor object — `undefined` when
 * it is one (its kind is judged by the stale-check next).
 *
 * THE anchor item-shape predicate: the validator (`invalid-anchor`), the
 * stale-check (an INVALID row) and {@link knowledgeAnchors} all apply it, so an
 * item is reported where it is judged and skipped where it is used — a `null`
 * item crashed `knowledge stale-check` and `knowledge anchors` (round 15
 * review).
 */
export function anchorShapeProblem(anchor: unknown): string | undefined {
  if (anchor === null || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return `is not an object (got ${describeEntryValue(anchor)})`;
  }
  for (const field of STRING_FIELDS) {
    const value = (anchor as Record<string, unknown>)[field];
    if (value !== undefined && typeof value !== 'string') {
      return `has a non-string \`${field}\` (got ${describeEntryValue(value)})`;
    }
  }
  return undefined;
}

/**
 * Why an entry's `anchors` VALUE is not a list — `undefined` when it is one (or
 * absent). Like a non-list `references`: a validation issue that KEEPS the
 * entry, never a crash (`{} is not iterable` took `knowledge stale-check`,
 * `knowledge anchors` and `ide symbol` down, and `quality`'s knowledge item
 * could not run).
 */
export function anchorsListProblem(value: unknown): string | undefined {
  if (value === undefined || value === null || Array.isArray(value)) return undefined;
  return `\`anchors\` must be a list (got ${describeEntryValue(value)}) — write an array — anchors: [{ id: 'a', kind: 'file', path: 'src/a.ts' }]`;
}
