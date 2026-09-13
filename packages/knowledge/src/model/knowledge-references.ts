import { referenceShapeProblem } from '../validate/reference-shape-problem.ts';
import type { IKnowledgeReference } from './knowledge-entry.ts';

/**
 * Every `references[]` item AS DECLARED — `[]` when absent or when the value is
 * not a list. For the two readers that JUDGE items — the validator
 * (`invalid-reference`) and the stale-check (an INVALID row) — so a string,
 * a null or a map with a list `path` is reported, never skipped. Everything
 * else reads {@link knowledgeReferences}.
 */
export function declaredReferenceItems(entry: { readonly references?: unknown }): readonly unknown[] {
  return Array.isArray(entry.references) ? entry.references : [];
}

/**
 * An entry's usable references — the well-typed objects of a list-valued
 * `references` (`referenceShapeProblem` passes them); `[]` when absent or
 * malformed. THE accessor every consumer that USES references iterates.
 *
 * A TypeScript literal or a Markdown frontmatter can declare `references:
 * 'src/a.ts'` (or an item like `path: [a, b]`), and `(entry.references ??
 * []).forEach` crashed every inspection-backed verb on it — a pack shipping
 * one crashed the consumer's `doctor` (round 15). What is dropped here is not
 * silent: the validator and the stale-check judge every declared item
 * ({@link declaredReferenceItems}).
 */
export function knowledgeReferences(entry: { readonly references?: unknown }): readonly IKnowledgeReference[] {
  const items = declaredReferenceItems(entry);
  return items.every((r) => referenceShapeProblem(r) === undefined)
    ? (items as readonly IKnowledgeReference[])
    : (items.filter((r) => referenceShapeProblem(r) === undefined) as IKnowledgeReference[]);
}
