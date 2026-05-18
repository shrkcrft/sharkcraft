/**
 * Preview only. Source-side rename remains out of scope (would need
 * an AST pass). Existing `sharkcraft/knowledge-updates/` patch files
 * on disk are left alone (users may have generated them
 * deliberately).
 *
 * Schema: sharkcraft.knowledge-rename/v2.
 */

import type {
  IKnowledgeAnchor,
  IKnowledgeEntry,
  IKnowledgeReference,
} from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const KNOWLEDGE_RENAME_SCHEMA = 'sharkcraft.knowledge-rename/v2';

export interface IKnowledgeRenameMatch {
  entryId: string;
  field: 'reference' | 'anchor';
  before: IKnowledgeReference | IKnowledgeAnchor;
  after: IKnowledgeReference | IKnowledgeAnchor;
}

export interface IKnowledgeRenamePlan {
  schema: typeof KNOWLEDGE_RENAME_SCHEMA;
  kind: 'rename-symbol' | 'rename-file' | 'update-anchor';
  from: string;
  to: string;
  matches: ReadonlyArray<IKnowledgeRenameMatch>;
}

export interface IKnowledgeRenameOptions {
  from: string;
  to: string;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function buildRenameSymbolPlan(
  inspection: ISharkcraftInspection,
  opts: IKnowledgeRenameOptions,
): IKnowledgeRenamePlan {
  const matches: IKnowledgeRenameMatch[] = [];
  for (const entry of inspection.knowledgeEntries as IKnowledgeEntry[]) {
    for (const ref of entry.references ?? []) {
      if (ref.kind === 'symbol' && ref.symbol === opts.from) {
        const after = clone(ref);
        after.symbol = opts.to;
        matches.push({ entryId: entry.id, field: 'reference', before: ref, after });
      }
    }
    for (const anchor of entry.anchors ?? []) {
      if (anchor.kind === 'symbol' && anchor.symbol === opts.from) {
        const after = clone(anchor);
        after.symbol = opts.to;
        matches.push({ entryId: entry.id, field: 'anchor', before: anchor, after });
      }
    }
  }
  return {
    schema: KNOWLEDGE_RENAME_SCHEMA,
    kind: 'rename-symbol',
    from: opts.from,
    to: opts.to,
    matches,
  };
}

export function buildRenameFilePlan(
  inspection: ISharkcraftInspection,
  opts: IKnowledgeRenameOptions,
): IKnowledgeRenamePlan {
  const matches: IKnowledgeRenameMatch[] = [];
  for (const entry of inspection.knowledgeEntries as IKnowledgeEntry[]) {
    for (const ref of entry.references ?? []) {
      if (ref.path === opts.from) {
        const after = clone(ref);
        after.path = opts.to;
        matches.push({ entryId: entry.id, field: 'reference', before: ref, after });
      }
    }
    for (const anchor of entry.anchors ?? []) {
      if (anchor.path === opts.from) {
        const after = clone(anchor);
        after.path = opts.to;
        matches.push({ entryId: entry.id, field: 'anchor', before: anchor, after });
      }
    }
  }
  return {
    schema: KNOWLEDGE_RENAME_SCHEMA,
    kind: 'rename-file',
    from: opts.from,
    to: opts.to,
    matches,
  };
}

export interface IAnchorUpdateOptions {
  anchorId: string;
  toSymbol?: string;
  toPath?: string;
  toTargetId?: string;
}

export function buildAnchorUpdatePlan(
  inspection: ISharkcraftInspection,
  opts: IAnchorUpdateOptions,
): IKnowledgeRenamePlan {
  const matches: IKnowledgeRenameMatch[] = [];
  for (const entry of inspection.knowledgeEntries as IKnowledgeEntry[]) {
    for (const anchor of entry.anchors ?? []) {
      if (anchor.id !== opts.anchorId) continue;
      const after = clone(anchor);
      if (opts.toSymbol !== undefined) after.symbol = opts.toSymbol;
      if (opts.toPath !== undefined) after.path = opts.toPath;
      if (opts.toTargetId !== undefined) after.targetId = opts.toTargetId;
      matches.push({ entryId: entry.id, field: 'anchor', before: anchor, after });
    }
  }
  return {
    schema: KNOWLEDGE_RENAME_SCHEMA,
    kind: 'update-anchor',
    from: opts.anchorId,
    to: opts.toSymbol ?? opts.toPath ?? opts.toTargetId ?? '?',
    matches,
  };
}
