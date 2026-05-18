/**
 * Knowledge authoring preview.
 *
 * Pure, deterministic builders that take a structured authoring request
 * (add / update / remove) and return a draft + patch preview. Preview-only:
 * this module never writes — the CLI adapter materialises the preview under
 * `.sharkcraft/authoring/` (drafts) or `.sharkcraft/fixes/` (lint output).
 *
 * Hard rules:
 *   - No mutation of `sharkcraft/knowledge.ts` or any pack `assets/knowledge.ts`.
 *   - Generated content references real, deterministic IKnowledgeEntry fields.
 *   - Add refuses to overwrite an existing id unless told to.
 *   - Update preserves all unspecified fields verbatim.
 *   - Remove always reports reverse references and refuses by default if any
 *     remain.
 */

import type {
  IKnowledgeAnchor,
  IKnowledgeEntry,
  IKnowledgeReference,
} from '@shrkcrft/knowledge';

export const KNOWLEDGE_AUTHORING_SCHEMA = 'sharkcraft.knowledge-authoring/v1';

export enum KnowledgeAuthoringOperation {
  Add = 'add',
  Update = 'update',
  Remove = 'remove',
}

export interface IKnowledgeAuthoringInput {
  operation: KnowledgeAuthoringOperation;
  /** Target entry id. Required for all operations. */
  id: string;
  /** Used by `add` (and as an override for `update`). */
  title?: string;
  /** IKnowledgeEntry.type. Defaults to 'documentation' for add. */
  type?: string;
  /** IKnowledgeEntry.priority. Defaults to 'medium' for add. */
  priority?: 'critical' | 'high' | 'medium' | 'low';
  /** Free-text body. */
  content?: string;
  /** Optional one-line summary. */
  summary?: string;
  /** Scope tags. */
  scope?: readonly string[];
  /** Tags. */
  tags?: readonly string[];
  /** appliesWhen lifecycle markers. */
  appliesWhen?: readonly string[];
  /** Related entry ids. */
  related?: readonly string[];
  /** References to add/replace. */
  references?: readonly IKnowledgeReference[];
  /** Anchors to add/replace. */
  anchors?: readonly IKnowledgeAnchor[];
  /** Action hints raw object (optional). */
  actionHints?: Record<string, unknown>;
  /** Patch operations for update only — incremental changes that
   * preserve unspecified fields. */
  updateOps?: IKnowledgeUpdateOps;
  /** Provenance reason — recorded in the draft + provenance ledger. */
  reason?: string;
  /** Optional pack/local target hint (for the explainer). */
  target?: IKnowledgeAuthoringTarget;
  /** When true (Remove only) — produce the preview even if reverse
   * references exist. Default false → returns a refused result. */
  forcePreview?: boolean;
  /** Treats add of an existing id as an update. Default false. */
  allowOverwrite?: boolean;
}

export interface IKnowledgeUpdateOps {
  addReferences?: readonly IKnowledgeReference[];
  removeReferences?: readonly { kind: string; id?: string; path?: string; symbol?: string }[];
  addAnchors?: readonly IKnowledgeAnchor[];
  removeAnchorIds?: readonly string[];
  addRelated?: readonly string[];
  removeRelated?: readonly string[];
  setSummary?: string;
  setContent?: string;
  setPriority?: 'critical' | 'high' | 'medium' | 'low';
  /** Set `metadata.deprecated = true` (preserved as a metadata field). */
  markDeprecated?: boolean;
  /** Clear deprecated flag. */
  unmarkDeprecated?: boolean;
}

export interface IKnowledgeAuthoringTarget {
  /** 'local' = sharkcraft/knowledge.ts, 'pack' = a pack assets/knowledge.ts. */
  kind: 'local' | 'pack';
  /** Project-relative file the human would copy the draft into. */
  filePath?: string;
  /** Pack package name when kind === 'pack'. */
  packName?: string;
}

export interface IKnowledgeAuthoringDraftFile {
  path: string;
  body: string;
  language: 'typescript' | 'json' | 'markdown';
}

export interface IKnowledgeAuthoringResult {
  schema: typeof KNOWLEDGE_AUTHORING_SCHEMA;
  generatedAt: string;
  operation: KnowledgeAuthoringOperation;
  entryId: string;
  /** False when the operation was refused (e.g. remove with reverse
   * references and no --force-preview). */
  ok: boolean;
  /** When ok=false, this explains why. */
  refusal?: string;
  /** The TS draft an agent can paste into the target knowledge file. */
  tsDraft: IKnowledgeAuthoringDraftFile;
  /** Machine manifest summarising the planned change. */
  jsonManifest: IKnowledgeAuthoringDraftFile;
  /** Markdown explainer + next commands. */
  explainer: IKnowledgeAuthoringDraftFile;
  /** Optional JSON patch — semantic diff for update/remove. */
  patch?: IKnowledgeAuthoringPatch;
  /** Warnings (do not fail generation). */
  warnings: readonly string[];
  /** Next commands an agent should run after applying the draft. */
  nextCommands: readonly string[];
  /** For update/remove — the resolved current entry (before change). */
  current?: IKnowledgeEntry;
  /** For update — the projected entry shape after applying ops. */
  next?: IKnowledgeEntry;
  /** For remove — entries that still reference this id (advisory ladder). */
  reverseReferences?: readonly IReverseReference[];
  /** True if a deprecation was suggested instead of removal. */
  suggestedDeprecationInstead?: boolean;
}

export interface IReverseReference {
  fromEntryId: string;
  field: 'related' | 'reference.id' | 'reference.symbol' | 'reference.path' | 'anchor.targetId';
  note?: string;
}

export interface IKnowledgeAuthoringPatch {
  schema: 'sharkcraft.knowledge-authoring-patch/v1';
  operation: KnowledgeAuthoringOperation;
  entryId: string;
  changes: readonly IKnowledgeAuthoringPatchChange[];
}

export interface IKnowledgeAuthoringPatchChange {
  op: 'add' | 'remove' | 'replace';
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface IKnowledgeAuthoringContext {
  /** Currently loaded entries — used for reverse-ref + duplicate detection. */
  entries: readonly IKnowledgeEntry[];
}

const ID_RE = /^[a-z0-9]+([.\-][a-z0-9]+)*$/;

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function idToConst(id: string): string {
  return id
    .split(/[.\-]/)
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
}

function fileSafeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-');
}

function tsScalar(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function tsArray(items: readonly unknown[], indent: string): string {
  if (items.length === 0) return '[]';
  return (
    '[\n' +
    items.map((it) => `${indent}  ${JSON.stringify(it)},`).join('\n') +
    `\n${indent}]`
  );
}

function tsObject(value: unknown, indent: string): string {
  // We keep this conservative — the goal is a TS-pasteable literal, not a
  // full TS pretty-printer. JSON-compatible values only.
  return (
    JSON.stringify(value, null, 2)
      .split('\n')
      .map((line, idx) => (idx === 0 ? line : indent + line))
      .join('\n')
  );
}

function findReverseReferences(
  entries: readonly IKnowledgeEntry[],
  targetId: string,
): IReverseReference[] {
  const out: IReverseReference[] = [];
  for (const e of entries) {
    if (e.id === targetId) continue;
    for (const r of e.related ?? []) {
      if (r === targetId) {
        out.push({ fromEntryId: e.id, field: 'related' });
      }
    }
    for (const ref of e.references ?? []) {
      if (ref.id === targetId) {
        out.push({ fromEntryId: e.id, field: 'reference.id', note: ref.note });
      }
    }
    for (const a of e.anchors ?? []) {
      if (a.targetId === targetId) {
        out.push({ fromEntryId: e.id, field: 'anchor.targetId', note: a.description });
      }
    }
  }
  return out;
}

function buildEntryFromAdd(input: IKnowledgeAuthoringInput): IKnowledgeEntry {
  return {
    id: input.id,
    title: input.title ?? input.id,
    type: input.type ?? 'documentation',
    priority: input.priority ?? 'medium',
    scope: input.scope ? [...input.scope] : [],
    tags: input.tags ? [...input.tags] : [],
    appliesWhen: input.appliesWhen ? [...input.appliesWhen] : [],
    content: input.content ?? `TODO: describe ${input.id}.`,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.related ? { related: [...input.related] } : {}),
    ...(input.references ? { references: input.references.map(clone) } : {}),
    ...(input.anchors ? { anchors: input.anchors.map(clone) } : {}),
    ...(input.actionHints ? { actionHints: clone(input.actionHints) as IKnowledgeEntry['actionHints'] } : {}),
    ...(input.reason
      ? { metadata: { authoring: { reason: input.reason, generatedAt: nowIso() } } }
      : {}),
  };
}

function applyUpdateOps(
  current: IKnowledgeEntry,
  ops: IKnowledgeUpdateOps,
  changes: IKnowledgeAuthoringPatchChange[],
): IKnowledgeEntry {
  const next: IKnowledgeEntry = clone(current);
  if (ops.setSummary !== undefined) {
    changes.push({ op: 'replace', field: 'summary', before: current.summary, after: ops.setSummary });
    next.summary = ops.setSummary;
  }
  if (ops.setContent !== undefined) {
    changes.push({ op: 'replace', field: 'content', before: current.content, after: ops.setContent });
    next.content = ops.setContent;
  }
  if (ops.setPriority !== undefined) {
    changes.push({ op: 'replace', field: 'priority', before: current.priority, after: ops.setPriority });
    next.priority = ops.setPriority;
  }
  if (ops.addRelated && ops.addRelated.length > 0) {
    const existing = new Set(next.related ?? []);
    const added: string[] = [];
    for (const r of ops.addRelated) {
      if (!existing.has(r)) {
        existing.add(r);
        added.push(r);
      }
    }
    next.related = [...existing];
    if (added.length > 0) {
      changes.push({ op: 'add', field: 'related', after: added });
    }
  }
  if (ops.removeRelated && ops.removeRelated.length > 0) {
    const keep = (next.related ?? []).filter((r) => !ops.removeRelated!.includes(r));
    const removed = (next.related ?? []).filter((r) => ops.removeRelated!.includes(r));
    next.related = keep;
    if (removed.length > 0) {
      changes.push({ op: 'remove', field: 'related', before: removed });
    }
  }
  if (ops.addReferences && ops.addReferences.length > 0) {
    const merged = [...(next.references ?? [])];
    const added: IKnowledgeReference[] = [];
    for (const r of ops.addReferences) {
      const dup = merged.find(
        (m) =>
          m.kind === r.kind &&
          (m.id ?? '') === (r.id ?? '') &&
          (m.path ?? '') === (r.path ?? '') &&
          (m.symbol ?? '') === (r.symbol ?? ''),
      );
      if (!dup) {
        merged.push(clone(r));
        added.push(r);
      }
    }
    next.references = merged;
    if (added.length > 0) {
      changes.push({ op: 'add', field: 'references', after: added });
    }
  }
  if (ops.removeReferences && ops.removeReferences.length > 0) {
    const before = next.references ?? [];
    const keep = before.filter((m) => {
      return !ops.removeReferences!.some(
        (rm) =>
          m.kind === rm.kind &&
          (m.id ?? '') === (rm.id ?? '') &&
          (m.path ?? '') === (rm.path ?? '') &&
          (m.symbol ?? '') === (rm.symbol ?? ''),
      );
    });
    const removed = before.filter((m) => !keep.includes(m));
    next.references = keep;
    if (removed.length > 0) {
      changes.push({ op: 'remove', field: 'references', before: removed });
    }
  }
  if (ops.addAnchors && ops.addAnchors.length > 0) {
    const merged = [...(next.anchors ?? [])];
    const added: IKnowledgeAnchor[] = [];
    for (const a of ops.addAnchors) {
      if (!merged.some((m) => m.id === a.id)) {
        merged.push(clone(a));
        added.push(a);
      }
    }
    next.anchors = merged;
    if (added.length > 0) {
      changes.push({ op: 'add', field: 'anchors', after: added });
    }
  }
  if (ops.removeAnchorIds && ops.removeAnchorIds.length > 0) {
    const before = next.anchors ?? [];
    const keep = before.filter((a) => !ops.removeAnchorIds!.includes(a.id));
    const removed = before.filter((a) => ops.removeAnchorIds!.includes(a.id));
    next.anchors = keep;
    if (removed.length > 0) {
      changes.push({ op: 'remove', field: 'anchors', before: removed });
    }
  }
  if (ops.markDeprecated) {
    const md = (next.metadata ?? {}) as Record<string, unknown>;
    if (!md.deprecated) {
      next.metadata = { ...md, deprecated: true };
      changes.push({ op: 'add', field: 'metadata.deprecated', after: true });
    }
  }
  if (ops.unmarkDeprecated) {
    const md = (next.metadata ?? {}) as Record<string, unknown>;
    if (md.deprecated) {
      const { deprecated, ...rest } = md;
      void deprecated;
      next.metadata = rest;
      changes.push({ op: 'remove', field: 'metadata.deprecated', before: true });
    }
  }
  return next;
}

function buildTsDraft(entry: IKnowledgeEntry, op: KnowledgeAuthoringOperation): string {
  const constName = idToConst(entry.id);
  const fields: string[] = [];
  fields.push(`  id: ${tsScalar(entry.id)},`);
  fields.push(`  title: ${tsScalar(entry.title)},`);
  fields.push(`  type: ${tsScalar(entry.type)},`);
  fields.push(`  priority: ${tsScalar(entry.priority)},`);
  fields.push(`  scope: ${tsArray(entry.scope, '  ')},`);
  fields.push(`  tags: ${tsArray(entry.tags, '  ')},`);
  fields.push(`  appliesWhen: ${tsArray(entry.appliesWhen, '  ')},`);
  if (entry.summary) fields.push(`  summary: ${tsScalar(entry.summary)},`);
  fields.push(`  content: ${tsScalar(entry.content)},`);
  if (entry.related && entry.related.length > 0)
    fields.push(`  related: ${tsArray(entry.related, '  ')},`);
  if (entry.references && entry.references.length > 0)
    fields.push(`  references: ${tsObject(entry.references, '  ')},`);
  if (entry.anchors && entry.anchors.length > 0)
    fields.push(`  anchors: ${tsObject(entry.anchors, '  ')},`);
  if (entry.actionHints)
    fields.push(`  actionHints: ${tsObject(entry.actionHints, '  ')},`);
  if (entry.metadata) fields.push(`  metadata: ${tsObject(entry.metadata, '  ')},`);
  return (
    `// Generated by \`shrk knowledge ${op}\` (preview only — not yet written).\n` +
    `// Paste into sharkcraft/knowledge.ts or a pack's assets/knowledge.ts.\n` +
    `\n` +
    `export const ${constName} = {\n` +
    fields.join('\n') +
    '\n};\n'
  );
}

function buildJsonManifest(result: Partial<IKnowledgeAuthoringResult>): string {
  return JSON.stringify(result, null, 2) + '\n';
}

function buildExplainer(
  input: IKnowledgeAuthoringInput,
  result: Pick<
    IKnowledgeAuthoringResult,
    | 'ok'
    | 'operation'
    | 'entryId'
    | 'refusal'
    | 'reverseReferences'
    | 'suggestedDeprecationInstead'
    | 'nextCommands'
  >,
): string {
  const op = result.operation;
  const lines: string[] = [];
  lines.push(`# Knowledge authoring preview — ${op} ${result.entryId}`);
  lines.push('');
  if (!result.ok) {
    lines.push(`> Refused: ${result.refusal ?? 'unknown reason'}.`);
    lines.push('');
  }
  lines.push(`Generated: ${nowIso()}`);
  lines.push('');
  lines.push(`## What this preview is`);
  lines.push('');
  lines.push(
    `Preview-only. Nothing was written to \`sharkcraft/knowledge.ts\` or to any pack's \`assets/knowledge.ts\`. ` +
      'The TypeScript draft on disk is a copy you (or an agent) can paste into the canonical file.',
  );
  lines.push('');
  if (input.reason) {
    lines.push(`## Reason`);
    lines.push('');
    lines.push(input.reason);
    lines.push('');
  }
  if (result.reverseReferences && result.reverseReferences.length > 0) {
    lines.push(`## Reverse references`);
    lines.push('');
    for (const rr of result.reverseReferences) {
      lines.push(`- \`${rr.fromEntryId}\` → \`${rr.field}\`${rr.note ? ` — ${rr.note}` : ''}`);
    }
    lines.push('');
  }
  if (result.suggestedDeprecationInstead) {
    lines.push(`## Suggested safer alternative`);
    lines.push('');
    lines.push(
      'This entry is referenced elsewhere. Removing it can produce stale references. ' +
        `Consider marking it deprecated instead by running:\n\n` +
        '```\n' +
        `shrk knowledge update ${result.entryId} --mark-deprecated --reason "<why>"\n` +
        '```',
    );
    lines.push('');
  }
  lines.push(`## Next commands`);
  lines.push('');
  for (const c of result.nextCommands) lines.push(`- \`${c}\``);
  lines.push('');
  return lines.join('\n');
}

function buildResultFiles(
  entryId: string,
  op: KnowledgeAuthoringOperation,
  tsBody: string,
  manifestBody: string,
  explainerBody: string,
): {
  tsDraft: IKnowledgeAuthoringDraftFile;
  jsonManifest: IKnowledgeAuthoringDraftFile;
  explainer: IKnowledgeAuthoringDraftFile;
} {
  const slug = fileSafeId(entryId);
  return {
    tsDraft: {
      path: `.sharkcraft/authoring/knowledge-${op}-${slug}.draft.ts`,
      body: tsBody,
      language: 'typescript',
    },
    jsonManifest: {
      path: `.sharkcraft/authoring/knowledge-${op}-${slug}.manifest.json`,
      body: manifestBody,
      language: 'json',
    },
    explainer: {
      path: `.sharkcraft/authoring/knowledge-${op}-${slug}.md`,
      body: explainerBody,
      language: 'markdown',
    },
  };
}

export function buildKnowledgeAuthoringPreview(
  input: IKnowledgeAuthoringInput,
  context: IKnowledgeAuthoringContext,
): IKnowledgeAuthoringResult {
  const warnings: string[] = [];
  if (!ID_RE.test(input.id)) {
    warnings.push(
      `id "${input.id}" does not match the recommended pattern <namespace>.<kebab-id>.`,
    );
  }
  const existing = context.entries.find((e) => e.id === input.id);

  switch (input.operation) {
    case KnowledgeAuthoringOperation.Add: {
      if (existing && !input.allowOverwrite) {
        const refused: IKnowledgeAuthoringResult = {
          schema: KNOWLEDGE_AUTHORING_SCHEMA,
          generatedAt: nowIso(),
          operation: input.operation,
          entryId: input.id,
          ok: false,
          refusal: `An entry with id "${input.id}" already exists. Use \`shrk knowledge update ${input.id}\` instead, or pass --allow-overwrite to draft a replacement.`,
          tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
          jsonManifest: emptyDraftFile(input.id, input.operation, 'json'),
          explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
          warnings,
          nextCommands: [`shrk knowledge update ${input.id} --reason "<why>"`],
          current: existing,
        };
        const files = buildResultFiles(
          input.id,
          input.operation,
          '// Refused — entry already exists.\n',
          buildJsonManifest(refused),
          buildExplainer(input, refused),
        );
        refused.tsDraft = files.tsDraft;
        refused.jsonManifest = files.jsonManifest;
        refused.explainer = files.explainer;
        return refused;
      }
      const next = buildEntryFromAdd(input);
      if (!input.reason) warnings.push('No --reason provided. Provenance entry will record source only.');
      if (!input.summary && !input.content) warnings.push('Neither --summary nor --content provided. Body is a TODO stub.');
      const result: IKnowledgeAuthoringResult = {
        schema: KNOWLEDGE_AUTHORING_SCHEMA,
        generatedAt: nowIso(),
        operation: input.operation,
        entryId: input.id,
        ok: true,
        tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
        jsonManifest: emptyDraftFile(input.id, input.operation, 'json'),
        explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
        warnings,
        next,
        nextCommands: nextCommandsForAdd(input),
      };
      const files = buildResultFiles(
        input.id,
        input.operation,
        buildTsDraft(next, input.operation),
        buildJsonManifest({
          schema: KNOWLEDGE_AUTHORING_SCHEMA,
          generatedAt: result.generatedAt,
          operation: result.operation,
          entryId: result.entryId,
          ok: true,
          next,
          warnings,
        }),
        buildExplainer(input, result),
      );
      result.tsDraft = files.tsDraft;
      result.jsonManifest = files.jsonManifest;
      result.explainer = files.explainer;
      return result;
    }
    case KnowledgeAuthoringOperation.Update: {
      if (!existing) {
        const refused: IKnowledgeAuthoringResult = {
          schema: KNOWLEDGE_AUTHORING_SCHEMA,
          generatedAt: nowIso(),
          operation: input.operation,
          entryId: input.id,
          ok: false,
          refusal: `No entry with id "${input.id}" exists. Use \`shrk knowledge add\` instead.`,
          tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
          jsonManifest: emptyDraftFile(input.id, input.operation, 'json'),
          explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
          warnings,
          nextCommands: [`shrk knowledge add --id ${input.id}`],
        };
        const files = buildResultFiles(
          input.id,
          input.operation,
          '// Refused — entry does not exist.\n',
          buildJsonManifest(refused),
          buildExplainer(input, refused),
        );
        refused.tsDraft = files.tsDraft;
        refused.jsonManifest = files.jsonManifest;
        refused.explainer = files.explainer;
        return refused;
      }
      const changes: IKnowledgeAuthoringPatchChange[] = [];
      const next = input.updateOps
        ? applyUpdateOps(existing, input.updateOps, changes)
        : applyUpdateOps(existing, deriveOpsFromInput(input), changes);
      if (changes.length === 0) {
        warnings.push('No updateOps produced changes. Preview will mirror the existing entry.');
      }
      const result: IKnowledgeAuthoringResult = {
        schema: KNOWLEDGE_AUTHORING_SCHEMA,
        generatedAt: nowIso(),
        operation: input.operation,
        entryId: input.id,
        ok: true,
        tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
        jsonManifest: emptyDraftFile(input.id, input.operation, 'json'),
        explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
        warnings,
        current: existing,
        next,
        patch: {
          schema: 'sharkcraft.knowledge-authoring-patch/v1',
          operation: input.operation,
          entryId: input.id,
          changes,
        },
        nextCommands: nextCommandsForUpdate(input),
      };
      const files = buildResultFiles(
        input.id,
        input.operation,
        buildTsDraft(next, input.operation),
        buildJsonManifest({
          schema: KNOWLEDGE_AUTHORING_SCHEMA,
          generatedAt: result.generatedAt,
          operation: result.operation,
          entryId: result.entryId,
          ok: true,
          current: existing,
          next,
          patch: result.patch,
          warnings,
        }),
        buildExplainer(input, result),
      );
      result.tsDraft = files.tsDraft;
      result.jsonManifest = files.jsonManifest;
      result.explainer = files.explainer;
      return result;
    }
    case KnowledgeAuthoringOperation.Remove: {
      if (!existing) {
        const refused: IKnowledgeAuthoringResult = {
          schema: KNOWLEDGE_AUTHORING_SCHEMA,
          generatedAt: nowIso(),
          operation: input.operation,
          entryId: input.id,
          ok: false,
          refusal: `No entry with id "${input.id}" exists — nothing to remove.`,
          tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
          jsonManifest: emptyDraftFile(input.id, input.operation, 'json'),
          explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
          warnings,
          nextCommands: [],
        };
        const files = buildResultFiles(
          input.id,
          input.operation,
          '// Refused — entry does not exist.\n',
          buildJsonManifest(refused),
          buildExplainer(input, refused),
        );
        refused.tsDraft = files.tsDraft;
        refused.jsonManifest = files.jsonManifest;
        refused.explainer = files.explainer;
        return refused;
      }
      const reverseReferences = findReverseReferences(context.entries, input.id);
      if (reverseReferences.length > 0 && !input.forcePreview) {
        const refused: IKnowledgeAuthoringResult = {
          schema: KNOWLEDGE_AUTHORING_SCHEMA,
          generatedAt: nowIso(),
          operation: input.operation,
          entryId: input.id,
          ok: false,
          refusal: `Refused: ${reverseReferences.length} other entr${reverseReferences.length === 1 ? 'y references' : 'ies reference'} "${input.id}". Pass --force-preview to preview removal anyway, or prefer deprecation via \`shrk knowledge update ${input.id} --mark-deprecated\`.`,
          tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
          jsonManifest: emptyDraftFile(input.id, input.operation, 'json'),
          explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
          warnings,
          reverseReferences,
          suggestedDeprecationInstead: true,
          current: existing,
          nextCommands: [
            `shrk knowledge update ${input.id} --mark-deprecated --reason "${input.reason ?? '<why>'}"`,
            `shrk knowledge remove ${input.id} --force-preview --reason "${input.reason ?? '<why>'}"`,
          ],
        };
        const files = buildResultFiles(
          input.id,
          input.operation,
          `// Refused — ${reverseReferences.length} reverse reference(s). See manifest.\n`,
          buildJsonManifest(refused),
          buildExplainer(input, refused),
        );
        refused.tsDraft = files.tsDraft;
        refused.jsonManifest = files.jsonManifest;
        refused.explainer = files.explainer;
        return refused;
      }
      const result: IKnowledgeAuthoringResult = {
        schema: KNOWLEDGE_AUTHORING_SCHEMA,
        generatedAt: nowIso(),
        operation: input.operation,
        entryId: input.id,
        ok: true,
        tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
        jsonManifest: emptyDraftFile(input.id, input.operation, 'json'),
        explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
        warnings,
        reverseReferences,
        current: existing,
        patch: {
          schema: 'sharkcraft.knowledge-authoring-patch/v1',
          operation: input.operation,
          entryId: input.id,
          changes: [{ op: 'remove', field: '*', before: existing }],
        },
        nextCommands: nextCommandsForRemove(input),
      };
      const files = buildResultFiles(
        input.id,
        input.operation,
        buildRemovalNotice(existing),
        buildJsonManifest({
          schema: KNOWLEDGE_AUTHORING_SCHEMA,
          generatedAt: result.generatedAt,
          operation: result.operation,
          entryId: result.entryId,
          ok: true,
          current: existing,
          reverseReferences,
          warnings,
        }),
        buildExplainer(input, result),
      );
      result.tsDraft = files.tsDraft;
      result.jsonManifest = files.jsonManifest;
      result.explainer = files.explainer;
      return result;
    }
  }
}

function buildRemovalNotice(entry: IKnowledgeEntry): string {
  return (
    `// Knowledge removal preview for ${entry.id}.\n` +
    `// Delete the following const from the knowledge file:\n` +
    `//\n` +
    entry.content
      .split('\n')
      .slice(0, 6)
      .map((l) => `//   ${l}`)
      .join('\n') +
    `\n`
  );
}

function deriveOpsFromInput(input: IKnowledgeAuthoringInput): IKnowledgeUpdateOps {
  // When the caller passes flat fields instead of an explicit updateOps
  // block, derive the conservative ops it implies. We only set fields the
  // caller explicitly provided.
  const ops: IKnowledgeUpdateOps = {};
  if (input.summary !== undefined) ops.setSummary = input.summary;
  if (input.content !== undefined) ops.setContent = input.content;
  if (input.priority !== undefined) ops.setPriority = input.priority;
  if (input.references && input.references.length > 0) ops.addReferences = input.references;
  if (input.anchors && input.anchors.length > 0) ops.addAnchors = input.anchors;
  if (input.related && input.related.length > 0) ops.addRelated = input.related;
  return ops;
}

function nextCommandsForAdd(input: IKnowledgeAuthoringInput): string[] {
  const targetHint = input.target?.filePath
    ? `# Target: ${input.target.filePath}`
    : '# Target: sharkcraft/knowledge.ts (or a pack assets/knowledge.ts)';
  return [
    targetHint,
    `shrk knowledge stale-check --ci`,
    `shrk self-config doctor`,
    `shrk packs signature-status`,
    `# Pack edits make signatures stale — see \`shrk packs sign --print-command\` when secret is available.`,
  ];
}

function nextCommandsForUpdate(input: IKnowledgeAuthoringInput): string[] {
  return [
    `# Apply the patch to ${input.target?.filePath ?? 'the knowledge file that owns this entry'}.`,
    `shrk knowledge stale-check --ci`,
    `shrk self-config doctor`,
    `shrk packs signature-status`,
  ];
}

function nextCommandsForRemove(input: IKnowledgeAuthoringInput): string[] {
  return [
    `# Delete the entry from ${input.target?.filePath ?? 'the knowledge file that owns this entry'}.`,
    `shrk knowledge stale-check --ci`,
    `shrk self-config doctor`,
    `shrk packs signature-status`,
  ];
}

function emptyDraftFile(
  id: string,
  op: KnowledgeAuthoringOperation,
  language: 'typescript' | 'json' | 'markdown',
): IKnowledgeAuthoringDraftFile {
  const slug = fileSafeId(id);
  const ext = language === 'typescript' ? 'draft.ts' : language === 'json' ? 'manifest.json' : 'md';
  return {
    path: `.sharkcraft/authoring/knowledge-${op}-${slug}.${ext}`,
    body: '',
    language,
  };
}
