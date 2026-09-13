import type { IKnowledgeAnchor, IKnowledgeReference } from '../model/knowledge-entry.ts';
import type { IMalformedKnowledgeClaim } from './i-malformed-knowledge-claim.ts';

/**
 * What one knowledge entry declares to be checked — `shrk knowledge references
 * <id>` and MCP `get_knowledge_references` print THIS record
 * ({@link knowledgeReferenceListing}), so the two cannot disagree.
 */
export interface IKnowledgeReferenceListing {
  readonly id: string;
  readonly title: string;
  /** The usable references (`knowledgeReferences`). */
  readonly references: readonly IKnowledgeReference[];
  /** The usable anchors (`knowledgeAnchors`). */
  readonly anchors: readonly IKnowledgeAnchor[];
  /** Every declared item (or non-list value) the two lists above could not hold, with why — `[]` when none. */
  readonly malformed: readonly IMalformedKnowledgeClaim[];
}
