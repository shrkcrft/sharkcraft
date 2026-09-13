import { ASSET_REFERENCE_KINDS, type AssetReferenceKind, type IAssetReference } from '@shrkcrft/core';
import type { KnowledgeType } from './knowledge-type.ts';
import type { KnowledgePriority } from './knowledge-priority.ts';
import type { IActionHints } from './action-hints.ts';

export interface IKnowledgeExample {
  title?: string;
  description?: string;
  code?: string;
  language?: string;
}

export interface IKnowledgeSource {
  /** Originating file path or URL. */
  origin?: string;
  /** Optional identifier of the loader that produced this entry. */
  loader?: string;
}

/**
 * What a knowledge reference points at — core's {@link AssetReferenceKind},
 * the one vocabulary boundary rules and policy checks share.
 */
export type KnowledgeReferenceKind = AssetReferenceKind;

/**
 * Every valid {@link KnowledgeReferenceKind}. The validator, the stale-check
 * and the authoring grammar all read this list, so a kind cannot be accepted
 * by one and unknown to another.
 */
export const KNOWLEDGE_REFERENCE_KINDS: readonly KnowledgeReferenceKind[] = ASSET_REFERENCE_KINDS;

/**
 * Structured reference attached to a knowledge entry.
 *
 * References make the entry verifiable: stale-check confirms each target
 * still exists — and, with `contains` / `matches` / `count`, that it still
 * says what the entry claims; rename advisory reports affected entries when a
 * target is renamed. The shape is core's {@link IAssetReference}.
 */
export type IKnowledgeReference = IAssetReference;

/**
 * Anchor — a named point inside or related to an entry. Anchors are what
 * the rename advisory tool updates when a target is moved.
 */
export type KnowledgeAnchorKind =
  | 'file'
  | 'symbol'
  | 'command'
  | 'construct'
  | 'template'
  | 'helper'
  | 'playbook'
  | 'policy';

export interface IKnowledgeAnchor {
  id: string;
  kind: KnowledgeAnchorKind;
  path?: string;
  symbol?: string;
  targetId?: string;
  description?: string;
}

export interface IKnowledgeEntry {
  id: string;
  title: string;
  type: KnowledgeType | string;
  priority: KnowledgePriority | string;
  scope: readonly string[];
  tags: readonly string[];
  appliesWhen: readonly string[];
  content: string;
  summary?: string;
  examples?: readonly IKnowledgeExample[];
  related?: readonly string[];
  source?: IKnowledgeSource;
  metadata?: Readonly<Record<string, unknown>>;
  /**
   * Optional structured action guidance for AI agents. When present, the
   * context builder surfaces commands / MCP tools / forbidden actions /
   * verification commands etc. so the agent does not have to guess the flow.
   */
  actionHints?: IActionHints;
  /**
   * Author-set opt-out from action-hint coverage: `true` marks an entry as
   * legitimately having NO actionable next step (a context-only overview, a
   * glossary, an architecture thesis) so it is excluded from the hint-coverage
   * denominator. This is the precise, per-entry lever — preferred over the coarse
   * type allowlist ({@link KNOWLEDGE_TYPES_NO_ACTION}, kept as a conservative
   * floor). Reach for it only when a real hint isn't natural; where one IS
   * natural (e.g. a path convention → `shrk why <path>`), give the entry a real
   * hint instead of exempting it.
   */
  noAction?: boolean;
  /**
   * Optional verifiable references to repo artefacts.
   *
   * Optional — entries that omit this field still load.
   */
  references?: readonly IKnowledgeReference[];
  /**
   * Optional named anchors describing what the entry is *about*.
   * Anchors get updated by `shrk knowledge rename-symbol|rename-file`.
   */
  anchors?: readonly IKnowledgeAnchor[];
  /**
   * `YYYY-MM-DD` — the day an author last checked this entry's claims against
   * the code. Author attestation, not index freshness: it answers "what has
   * nobody looked at in N months" (`stale-check --stale-after 6m`), which
   * reference existence alone cannot.
   */
  verifiedOn?: string;
  /**
   * Ids — of ANY registered kind — a reader should also look at: the
   * structured form of prose "see also `<id>`". Resolved by the declared
   * cross-reference collector (`shrk self-config doctor`) and rendered by
   * `shrk knowledge get` with the namespace each id resolved into.
   */
  seeAlso?: readonly string[];
  /**
   * Knowledge ids that replace this entry; non-empty means SUPERSEDED.
   * `shrk knowledge get` prints a banner routing the reader to the current
   * entry (`--follow` renders it). A successor that resolves to no knowledge
   * entry is an error, not prose that points into a dead id.
   */
  supersededBy?: readonly string[];
}
