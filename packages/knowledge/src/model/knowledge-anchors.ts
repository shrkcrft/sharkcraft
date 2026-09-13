import { anchorShapeProblem } from '../validate/anchor-shape-problem.ts';
import type { IKnowledgeAnchor } from './knowledge-entry.ts';

/**
 * Every `anchors[]` item AS DECLARED — `[]` when absent or when the value is
 * not a list. For the two readers that JUDGE items — the validator
 * (`invalid-anchor`) and the stale-check (an INVALID row) — so a `null` or a
 * string item is reported, never skipped. Everything else reads
 * {@link knowledgeAnchors}.
 */
export function declaredAnchorItems(entry: { readonly anchors?: unknown }): readonly unknown[] {
  return Array.isArray(entry.anchors) ? entry.anchors : [];
}

/**
 * An entry's usable anchors — the well-typed objects of a list-valued
 * `anchors` (`anchorShapeProblem` passes them); `[]` when absent or malformed.
 * THE accessor every consumer that USES anchors iterates (the
 * {@link knowledgeReferences} twin).
 *
 * `(entry.anchors ?? [])` crashed `knowledge stale-check`, `knowledge anchors`
 * and `ide symbol` on `anchors: { … }` or a `null` item (round 15 review). What
 * is dropped here is not silent: the validator and the stale-check judge every
 * declared item ({@link declaredAnchorItems}).
 */
export function knowledgeAnchors(entry: { readonly anchors?: unknown }): readonly IKnowledgeAnchor[] {
  const items = declaredAnchorItems(entry);
  return items.every((a) => anchorShapeProblem(a) === undefined)
    ? (items as readonly IKnowledgeAnchor[])
    : (items.filter((a) => anchorShapeProblem(a) === undefined) as IKnowledgeAnchor[]);
}
