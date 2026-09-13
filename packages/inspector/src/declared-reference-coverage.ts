import type { IVerdictCoverage } from '@shrkcrft/core';
import { formatKnowledgeReference } from '@shrkcrft/knowledge';
import {
  isCheckableOutcome,
  ReferenceCheckOutcome,
  type IKnowledgeAnchorCheck,
  type IKnowledgeReferenceCheck,
} from './knowledge-stale.ts';

/** Unexamined labels carried on the coverage record (the full list is in the JSON). */
const LABEL_CAP = 20;

/** Why a malformed reference is unexamined — the words every surface prints. */
export const MALFORMED_REFERENCE_REASON =
  'malformed (a kind outside the vocabulary, or a required field missing), so never checked — `shrk doctor` names each';

/**
 * THE fold of declared references into one coverage record.
 *
 * A reference whose outcome was CHECKED (ok / stale / missing —
 * `isCheckableOutcome`) was examined. A MALFORMED one (`invalid`) was declared
 * to be checked and never was: it is expected, not examined, so a run holding
 * one is never a clean pass. An `unknown` one (a url, an unpinned or ambiguous
 * symbol, a file that failed to read) is neither: the stale-check accounts for
 * it at the ENTRY level (an entry with nothing checkable is unverifiable), so
 * it leaves both sides here — which is why a scope of ONLY unknown references
 * is `expected: 0`, "nothing to examine", never a pass.
 *
 * `shrk knowledge stale-check` / `verify` (and so `shrk quality`, MCP
 * `get_quality_report`, the dashboard) and the `shrk gate` knowledge-symbol
 * gate all settle on this one record — the gate used to count every
 * non-stale, non-missing reference as "resolving", so a malformed or unpinned
 * reference read as a pass there while the stale-check said 2.
 */
export function declaredReferenceCoverage(input: {
  readonly references: readonly IKnowledgeReferenceCheck[];
  readonly anchors?: readonly IKnowledgeAnchorCheck[];
}): IVerdictCoverage {
  const anchors = input.anchors ?? [];
  const invalidRefs = input.references.filter((c) => c.outcome === ReferenceCheckOutcome.Invalid);
  const invalidAnchors = anchors.filter((a) => a.outcome === ReferenceCheckOutcome.Invalid);
  const invalidCount = invalidRefs.length + invalidAnchors.length;
  const invalidLabels = [
    ...invalidRefs.map((c) => `${c.entryId} → ${formatKnowledgeReference(c.reference)}`),
    ...invalidAnchors.map((a) => `${a.entryId} anchor[${a.anchor.id}]`),
  ];
  const checkable =
    input.references.filter((c) => isCheckableOutcome(c.outcome)).length +
    anchors.filter((a) => isCheckableOutcome(a.outcome)).length;
  return {
    unit: 'declared references',
    expected: checkable + invalidCount,
    examined: checkable,
    ...(invalidCount > 0
      ? {
          unexamined: invalidLabels.slice(0, LABEL_CAP),
          unexaminedTotal: invalidCount,
          reason: MALFORMED_REFERENCE_REASON,
        }
      : checkable === 0
        ? { reason: 'no entry in scope declares a checkable reference' }
        : {}),
  };
}
