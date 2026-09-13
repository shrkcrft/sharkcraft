/**
 * THE knowledge-family reading of the round-12 rejection channel (round 15
 * follow-up, F3): every knowledge / rule / path / docs entry an inspection-time
 * loader REFUSED — a TypeScript entry missing its `content`, a Markdown file
 * whose frontmatter cannot be read as declared.
 *
 * A refused entry never reaches `inspection.knowledgeEntries`, so the
 * stale-check swept the survivors and printed "N of N entries verified ✓" at
 * exit 0 over a corpus it had not fully read, and `quality` and `shrk doctor`
 * agreed — only `self-config doctor` and `knowledge list` named it. The
 * stale-check (an INVALID-class row), `quality`'s knowledge item and `shrk
 * doctor` now read this ONE list, and each counts every entry on it as
 * UNEXAMINED: exit 2 by default (`--fail-on invalid` makes it 1), never a pass.
 *
 * The list is never narrowed by a changeset: a refused entry's references were
 * never read, so no scope can prove it untouched (the load-failure precedent).
 *
 * A `duplicate-id` rejection is NOT listed: the id it collided with belongs to
 * an entry that IS checked (the first one wins), and the validator reports the
 * duplicate — the precedent `seamRejectedRules` set for gate rules.
 */
import { RejectionCause } from '@shrkcrft/core';
import { ContributionKind } from './contribution-kind.ts';
import { collectContributionRejections, contributionFileLabel } from './contribution-load-failures.ts';
import type { IKnowledgeRejectedEntry } from './knowledge-rejected-entry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

/** Every contribution kind the knowledge loaders read (knowledge, rules, paths, path conventions, docs). */
export const KNOWLEDGE_CONTRIBUTION_KINDS: readonly ContributionKind[] = [
  ContributionKind.Knowledge,
  ContributionKind.Rule,
  ContributionKind.Path,
  ContributionKind.PathConvention,
  ContributionKind.Docs,
];

/** The label every surface prints before a refused entry's reasons. */
export const REJECTED_AT_LOAD = 'rejected at load — not checked';

/** `rejected at load — not checked: <reason>; <reason>` — THE row wording. */
export function rejectedAtLoadMessage(reasons: readonly string[]): string {
  return `${REJECTED_AT_LOAD}: ${reasons.join('; ')}`;
}

/**
 * Every knowledge-family entry the loaders refused, in THE channel's order
 * (file, then position), each with the file to edit and the owning pack.
 * Synchronous: the knowledge loaders run at inspection time, so their
 * rejections are already on `inspection.loaderDiagnostics`.
 */
export function knowledgeRejectedEntries(inspection: ISharkcraftInspection): readonly IKnowledgeRejectedEntry[] {
  const out: IKnowledgeRejectedEntry[] = [];
  // A label names ONE refused declaration (the conventions-check precedent,
  // round 15 follow-up F2): an id a loaded entry, or an earlier refused
  // declaration, already holds is qualified by its declaration site — two
  // refused `k.bad`s (a local one and a pack's) read `k.bad, k.bad` in every
  // coverage list and shared one doctor check id.
  const loaded = new Set(inspection.knowledgeEntries.map((e) => e.id));
  const refusedIds = new Set<string>();
  for (const r of collectContributionRejections(inspection)) {
    if (!KNOWLEDGE_CONTRIBUTION_KINDS.includes(r.kind) || r.cause === RejectionCause.DuplicateId) continue;
    const source = contributionFileLabel(inspection.projectRoot, r.file);
    const at = r.index >= 0 ? `${r.exportName ?? 'default'}[${r.index}]` : r.exportName;
    const site = at !== undefined ? `${source} ${at}` : source;
    const label =
      r.entryId === undefined
        ? site
        : loaded.has(r.entryId) || refusedIds.has(r.entryId)
          ? `${r.entryId} (${site})`
          : r.entryId;
    if (r.entryId !== undefined) refusedIds.add(r.entryId);
    out.push({
      ...(r.entryId !== undefined ? { entryId: r.entryId } : {}),
      label,
      source,
      ...(at !== undefined ? { at } : {}),
      kind: r.kind,
      ...(r.packageName !== undefined ? { pack: r.packageName } : {}),
      reasons: r.reasons,
      message: rejectedAtLoadMessage(r.reasons),
    });
  }
  return out;
}
