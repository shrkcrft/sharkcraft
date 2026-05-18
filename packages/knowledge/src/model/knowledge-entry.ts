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
 * Structured reference attached to a knowledge entry.
 *
 * References make the entry verifiable: stale-check confirms each target
 * still exists; rename advisory reports affected entries when a target is
 * renamed.
 */
export type KnowledgeReferenceKind =
  | 'file'
  | 'directory'
  | 'symbol'
  | 'command'
  | 'template'
  | 'playbook'
  | 'construct'
  | 'helper'
  | 'policy'
  | 'boundary-rule'
  | 'path-convention'
  | 'package'
  | 'url';

export interface IKnowledgeReference {
  kind: KnowledgeReferenceKind;
  /** Project-relative path for `file` / `directory`. */
  path?: string;
  /** Symbol name for `symbol` references (function, class, type). */
  symbol?: string;
  /** Id for `command` / `template` / `playbook` / `construct` / `helper` / `policy` / `boundary-rule` / `path-convention` / `package`. */
  id?: string;
  /** Raw command line for `command` (alternative to `id`). */
  command?: string;
  /** Whether the stale-check treats a missing target as an error (default false). */
  required?: boolean;
  /** Free-form note carried verbatim. */
  note?: string;
}

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
}
