import { KnowledgeClaimField } from '../model/knowledge-claim-field.ts';
import { declaredAnchorItems, knowledgeAnchors } from '../model/knowledge-anchors.ts';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import { declaredReferenceItems, knowledgeReferences } from '../model/knowledge-references.ts';
import { knowledgeSourceFormat } from '../model/knowledge-source-format-of.ts';
import { anchorShapeProblem, anchorsListProblem } from '../validate/anchor-shape-problem.ts';
import { referenceShapeProblem, referencesListProblem } from '../validate/reference-shape-problem.ts';
import type { IKnowledgeReferenceListing } from './i-knowledge-reference-listing.ts';
import type { IMalformedKnowledgeClaim } from './i-malformed-knowledge-claim.ts';

/**
 * THE listing of what one knowledge entry declares to be checked: its usable
 * references and anchors, and every declared item — or non-list value — they
 * could not hold, with the problem `shrk doctor` reports for it.
 *
 * `shrk knowledge references <id>` (text and `--json`) and MCP
 * `get_knowledge_references` both print it (round 15 review): the CLI listed
 * only the well-typed references — a malformed item vanished from the one
 * verb that lists them — while MCP returned the raw value, so the two answered
 * "what does this entry reference?" differently.
 */
export function knowledgeReferenceListing(entry: IKnowledgeEntry): IKnowledgeReferenceListing {
  const malformed: IMalformedKnowledgeClaim[] = [];
  const listProblem = referencesListProblem(entry.references, knowledgeSourceFormat(entry));
  if (listProblem) malformed.push({ field: KnowledgeClaimField.References, value: entry.references, problem: listProblem });
  declaredReferenceItems(entry).forEach((value, i) => {
    const problem = referenceShapeProblem(value);
    if (problem) malformed.push({ field: KnowledgeClaimField.References, position: i + 1, value, problem });
  });
  const anchorsProblem = anchorsListProblem(entry.anchors);
  if (anchorsProblem) malformed.push({ field: KnowledgeClaimField.Anchors, value: entry.anchors, problem: anchorsProblem });
  declaredAnchorItems(entry).forEach((value, i) => {
    const problem = anchorShapeProblem(value);
    if (problem) malformed.push({ field: KnowledgeClaimField.Anchors, position: i + 1, value, problem });
  });
  return {
    id: entry.id,
    title: entry.title,
    references: knowledgeReferences(entry),
    anchors: knowledgeAnchors(entry),
    malformed,
  };
}

/** `reference #2` / `anchor #1` — or `references` / `anchors` for a whole non-list value (the doctor's spelling). */
export function malformedKnowledgeClaimLabel(claim: IMalformedKnowledgeClaim): string {
  const one = claim.field === KnowledgeClaimField.References ? 'reference' : 'anchor';
  return claim.position === undefined ? `\`${claim.field}\`` : `${one} #${claim.position}`;
}
