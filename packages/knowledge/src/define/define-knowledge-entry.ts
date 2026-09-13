import type {
  IKnowledgeAnchor,
  IKnowledgeEntry,
  IKnowledgeExample,
  IKnowledgeReference,
  IKnowledgeSource,
} from '../model/knowledge-entry.ts';
import type { IActionHints } from '../model/action-hints.ts';
import { KnowledgePriority } from '../model/knowledge-priority.ts';
import { isValidKnowledgeId } from '@shrkcrft/core';

export interface DefineKnowledgeInput {
  id: string;
  title: string;
  type: string;
  priority?: string;
  scope?: readonly string[];
  tags?: readonly string[];
  appliesWhen?: readonly string[];
  content: string;
  summary?: string;
  examples?: readonly IKnowledgeExample[];
  related?: readonly string[];
  source?: IKnowledgeSource;
  metadata?: Readonly<Record<string, unknown>>;
  actionHints?: IActionHints;
  /** Author opt-out: no actionable next step → excluded from hint-coverage. */
  noAction?: boolean;
  /** Verifiable references to repo artefacts (checked by `shrk knowledge stale-check`). */
  references?: readonly IKnowledgeReference[];
  /** Named anchors describing what the entry is about. */
  anchors?: readonly IKnowledgeAnchor[];
  /** `YYYY-MM-DD` — the day an author last checked this entry against the code. */
  verifiedOn?: string;
  /** Ids of any registered kind a reader should also look at. */
  seeAlso?: readonly string[];
  /** Knowledge ids that replace this entry (non-empty = superseded). */
  supersededBy?: readonly string[];
}

/** A list, frozen as a copy; any other value (a malformed `references: 'src/a.ts'`) carried as declared. */
function asDeclaredList<T>(value: readonly T[]): readonly T[] {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

export function defineKnowledgeEntry(input: DefineKnowledgeInput): IKnowledgeEntry {
  if (!input.id || typeof input.id !== 'string') {
    throw new Error(`defineKnowledgeEntry: 'id' is required (got ${String(input.id)})`);
  }
  if (!isValidKnowledgeId(input.id)) {
    throw new Error(
      `defineKnowledgeEntry: 'id' must match /^[a-z0-9]+([.-][a-z0-9]+)*$/ (got "${input.id}")`,
    );
  }
  if (!input.title) {
    throw new Error(`defineKnowledgeEntry: 'title' is required for ${input.id}`);
  }
  if (!input.type) {
    throw new Error(`defineKnowledgeEntry: 'type' is required for ${input.id}`);
  }
  if (typeof input.content !== 'string') {
    throw new Error(`defineKnowledgeEntry: 'content' is required for ${input.id}`);
  }

  return {
    id: input.id,
    title: input.title,
    type: input.type,
    priority: input.priority ?? KnowledgePriority.Medium,
    scope: Object.freeze([...(input.scope ?? [])]),
    tags: Object.freeze([...(input.tags ?? [])]),
    appliesWhen: Object.freeze([...(input.appliesWhen ?? [])]),
    content: input.content,
    summary: input.summary,
    examples: input.examples ? Object.freeze([...input.examples]) : undefined,
    related: input.related ? Object.freeze([...input.related]) : undefined,
    source: input.source,
    metadata: input.metadata,
    actionHints: input.actionHints,
    ...(input.noAction !== undefined ? { noAction: input.noAction } : {}),
    // References and anchors used to be dropped here, so an entry built with
    // the helper could never be verified by the stale-check it was declared for.
    // A NON-list value is carried as declared (round 15 review): spreading it
    // threw at import (`{ … }` is not iterable — the whole file failed to load)
    // or split a string into characters. The validator reports it and keeps the
    // entry, exactly as for the same value in a plain object literal.
    ...(input.references ? { references: asDeclaredList(input.references) } : {}),
    ...(input.anchors ? { anchors: asDeclaredList(input.anchors) } : {}),
    ...(input.verifiedOn !== undefined ? { verifiedOn: input.verifiedOn } : {}),
    ...(input.seeAlso ? { seeAlso: Object.freeze([...input.seeAlso]) } : {}),
    ...(input.supersededBy ? { supersededBy: Object.freeze([...input.supersededBy]) } : {}),
  };
}
