/**
 * Template authoring previews.
 *
 * Mirror of `knowledge-authoring.ts` for templates. Templates are TS-shaped
 * objects (not knowledge entries), so the draft body is a TS const literal
 * rather than a JSON-style entry. The CLI adapter writes drafts under
 * `.sharkcraft/authoring/templates/` and records provenance with
 * `AssetKind.Template`.
 *
 * Hard rules (same as knowledge-authoring):
 *   - Never mutates `sharkcraft/templates.ts` or any pack's
 *     `assets/templates.ts`.
 *   - Update preserves all unspecified fields verbatim.
 *   - Remove always reports reverse references and refuses by default
 *     when any remain (unless `forcePreview`).
 *
 * Scope: update + remove only. `scaffold` / `add` already ship at
 * `packages/cli/src/commands/templates.command.ts`.
 */

import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { IPipelineDefinition } from '@shrkcrft/pipelines';
import type { IPreset } from '@shrkcrft/presets';

export const TEMPLATE_AUTHORING_SCHEMA = 'sharkcraft.template-authoring/v1';

export enum TemplateAuthoringOperation {
  Update = 'update',
  Remove = 'remove',
}

export interface ITemplateUpdateOps {
  setName?: string;
  setDescription?: string;
  addTags?: readonly string[];
  removeTags?: readonly string[];
  addScope?: readonly string[];
  removeScope?: readonly string[];
  addAppliesWhen?: readonly string[];
  removeAppliesWhen?: readonly string[];
  /** Add to metadata.requiredProfileIds. */
  addRequiredProfileIds?: readonly string[];
  removeRequiredProfileIds?: readonly string[];
  /** Add to metadata.forbiddenPathFragments. */
  addForbiddenPathFragments?: readonly string[];
  removeForbiddenPathFragments?: readonly string[];
  /** Add to related (knowledge entry ids). */
  addRelated?: readonly string[];
  removeRelated?: readonly string[];
  /** Append a postGenerationNote (preview only — the resolver still runs). */
  addPostGenerationNote?: string;
}

export interface ITemplateAuthoringInput {
  operation: TemplateAuthoringOperation;
  id: string;
  updateOps?: ITemplateUpdateOps;
  reason?: string;
  /** Override the default refusal when reverse references exist (remove). */
  forcePreview?: boolean;
}

export interface ITemplateAuthoringDraftFile {
  path: string;
  body: string;
  language: 'typescript' | 'markdown';
}

export interface ITemplateReverseReference {
  fromKind: 'knowledge' | 'pipeline' | 'preset' | 'pack';
  fromId: string;
  field: string;
  note?: string;
}

export interface ITemplateAuthoringPatchChange {
  op: 'add' | 'remove' | 'replace';
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface ITemplateAuthoringPatch {
  schema: 'sharkcraft.template-authoring-patch/v1';
  operation: TemplateAuthoringOperation;
  templateId: string;
  changes: readonly ITemplateAuthoringPatchChange[];
}

export interface ITemplateAuthoringResult {
  schema: typeof TEMPLATE_AUTHORING_SCHEMA;
  generatedAt: string;
  operation: TemplateAuthoringOperation;
  templateId: string;
  ok: boolean;
  refusal?: string;
  /** TS draft (update only — for `remove` it is a comment notice). */
  tsDraft: ITemplateAuthoringDraftFile;
  /** Markdown explainer + next commands. */
  explainer: ITemplateAuthoringDraftFile;
  /** Optional semantic patch (update only). */
  patch?: ITemplateAuthoringPatch;
  warnings: readonly string[];
  nextCommands: readonly string[];
  /** Resolved current definition (before change). */
  current?: ITemplateDefinition;
  /** Projected definition shape (update only). */
  next?: ITemplateDefinition;
  /** Reverse references blocking removal (remove only). */
  reverseReferences?: readonly ITemplateReverseReference[];
}

export interface ITemplateAuthoringContext {
  templates: readonly ITemplateDefinition[];
  /** Used to detect reverse references for `remove`. */
  knowledgeEntries?: readonly IKnowledgeEntry[];
  pipelines?: readonly IPipelineDefinition[];
  presets?: readonly IPreset[];
  /** Pack-contributed template ids by pack — used to flag if the target id is owned by a pack. */
  packTemplateIds?: ReadonlyMap<string, string>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function fileSafeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-');
}

function idToConst(id: string): string {
  return id
    .split(/[.\-]/)
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('') + 'Template';
}

function applyTemplateUpdateOps(
  current: ITemplateDefinition,
  ops: ITemplateUpdateOps,
  changes: ITemplateAuthoringPatchChange[],
): ITemplateDefinition {
  // Strip runtime resolvers — drafts cannot represent function bodies.
  const cur = clone({
    ...current,
    files: undefined,
    changes: undefined,
    targetPath: typeof current.targetPath === 'function' ? undefined : current.targetPath,
    content: typeof current.content === 'function' ? undefined : current.content,
  }) as ITemplateDefinition;
  const next: ITemplateDefinition = clone(cur);

  if (ops.setName !== undefined) {
    changes.push({ op: 'replace', field: 'name', before: cur.name, after: ops.setName });
    next.name = ops.setName;
  }
  if (ops.setDescription !== undefined) {
    changes.push({
      op: 'replace',
      field: 'description',
      before: cur.description,
      after: ops.setDescription,
    });
    next.description = ops.setDescription;
  }
  if (ops.addTags && ops.addTags.length > 0) {
    const set = new Set(next.tags);
    const added: string[] = [];
    for (const t of ops.addTags) if (!set.has(t)) { set.add(t); added.push(t); }
    next.tags = [...set];
    if (added.length > 0) changes.push({ op: 'add', field: 'tags', after: added });
  }
  if (ops.removeTags && ops.removeTags.length > 0) {
    const removed = next.tags.filter((t) => ops.removeTags!.includes(t));
    next.tags = next.tags.filter((t) => !ops.removeTags!.includes(t));
    if (removed.length > 0) changes.push({ op: 'remove', field: 'tags', before: removed });
  }
  if (ops.addScope && ops.addScope.length > 0) {
    const set = new Set(next.scope);
    const added: string[] = [];
    for (const t of ops.addScope) if (!set.has(t)) { set.add(t); added.push(t); }
    next.scope = [...set];
    if (added.length > 0) changes.push({ op: 'add', field: 'scope', after: added });
  }
  if (ops.removeScope && ops.removeScope.length > 0) {
    const removed = next.scope.filter((t) => ops.removeScope!.includes(t));
    next.scope = next.scope.filter((t) => !ops.removeScope!.includes(t));
    if (removed.length > 0) changes.push({ op: 'remove', field: 'scope', before: removed });
  }
  if (ops.addAppliesWhen && ops.addAppliesWhen.length > 0) {
    const set = new Set(next.appliesWhen);
    const added: string[] = [];
    for (const t of ops.addAppliesWhen) if (!set.has(t)) { set.add(t); added.push(t); }
    next.appliesWhen = [...set];
    if (added.length > 0) changes.push({ op: 'add', field: 'appliesWhen', after: added });
  }
  if (ops.removeAppliesWhen && ops.removeAppliesWhen.length > 0) {
    const removed = next.appliesWhen.filter((t) => ops.removeAppliesWhen!.includes(t));
    next.appliesWhen = next.appliesWhen.filter((t) => !ops.removeAppliesWhen!.includes(t));
    if (removed.length > 0) changes.push({ op: 'remove', field: 'appliesWhen', before: removed });
  }
  if (ops.addRelated && ops.addRelated.length > 0) {
    const cur = next.related ? [...next.related] : [];
    const set = new Set(cur);
    const added: string[] = [];
    for (const t of ops.addRelated) if (!set.has(t)) { set.add(t); added.push(t); }
    next.related = [...set];
    if (added.length > 0) changes.push({ op: 'add', field: 'related', after: added });
  }
  if (ops.removeRelated && ops.removeRelated.length > 0) {
    const cur = next.related ?? [];
    const removed = cur.filter((t) => ops.removeRelated!.includes(t));
    next.related = cur.filter((t) => !ops.removeRelated!.includes(t));
    if (removed.length > 0) changes.push({ op: 'remove', field: 'related', before: removed });
  }

  // metadata.* updates
  const md = next.metadata ? { ...next.metadata } : {};
  let mdTouched = false;
  if (ops.addRequiredProfileIds && ops.addRequiredProfileIds.length > 0) {
    const existing = md.requiredProfileIds ? [...md.requiredProfileIds] : [];
    const set = new Set(existing);
    const added: string[] = [];
    for (const id of ops.addRequiredProfileIds) {
      if (!set.has(id)) { set.add(id); added.push(id); }
    }
    md.requiredProfileIds = [...set];
    if (added.length > 0) {
      mdTouched = true;
      changes.push({ op: 'add', field: 'metadata.requiredProfileIds', after: added });
    }
  }
  if (ops.removeRequiredProfileIds && ops.removeRequiredProfileIds.length > 0) {
    const existing = md.requiredProfileIds ?? [];
    const removed = existing.filter((id) => ops.removeRequiredProfileIds!.includes(id));
    md.requiredProfileIds = existing.filter((id) => !ops.removeRequiredProfileIds!.includes(id));
    if (removed.length > 0) {
      mdTouched = true;
      changes.push({
        op: 'remove',
        field: 'metadata.requiredProfileIds',
        before: removed,
      });
    }
  }
  if (ops.addForbiddenPathFragments && ops.addForbiddenPathFragments.length > 0) {
    const existing = md.forbiddenPathFragments ? [...md.forbiddenPathFragments] : [];
    const set = new Set(existing);
    const added: string[] = [];
    for (const f of ops.addForbiddenPathFragments) {
      if (!set.has(f)) { set.add(f); added.push(f); }
    }
    md.forbiddenPathFragments = [...set];
    if (added.length > 0) {
      mdTouched = true;
      changes.push({ op: 'add', field: 'metadata.forbiddenPathFragments', after: added });
    }
  }
  if (ops.removeForbiddenPathFragments && ops.removeForbiddenPathFragments.length > 0) {
    const existing = md.forbiddenPathFragments ?? [];
    const removed = existing.filter((f) => ops.removeForbiddenPathFragments!.includes(f));
    md.forbiddenPathFragments = existing.filter(
      (f) => !ops.removeForbiddenPathFragments!.includes(f),
    );
    if (removed.length > 0) {
      mdTouched = true;
      changes.push({
        op: 'remove',
        field: 'metadata.forbiddenPathFragments',
        before: removed,
      });
    }
  }
  if (mdTouched) next.metadata = md;

  if (ops.addPostGenerationNote) {
    const cur = next.postGenerationNotes ? [...next.postGenerationNotes] : [];
    cur.push(ops.addPostGenerationNote);
    next.postGenerationNotes = cur;
    changes.push({
      op: 'add',
      field: 'postGenerationNotes',
      after: [ops.addPostGenerationNote],
    });
  }

  return next;
}

function findReverseReferences(
  templateId: string,
  ctx: ITemplateAuthoringContext,
): ITemplateReverseReference[] {
  const out: ITemplateReverseReference[] = [];
  // Knowledge entries referencing this template via `references[kind=template]`.
  for (const k of ctx.knowledgeEntries ?? []) {
    for (const ref of k.references ?? []) {
      if (ref.kind === 'template' && ref.id === templateId) {
        out.push({
          fromKind: 'knowledge',
          fromId: k.id,
          field: 'references[kind=template]',
          ...(ref.note ? { note: ref.note } : {}),
        });
      }
    }
    for (const rel of k.related ?? []) {
      if (rel === templateId) {
        out.push({ fromKind: 'knowledge', fromId: k.id, field: 'related' });
      }
    }
  }
  // Pipelines whose steps reference the template id.
  for (const p of ctx.pipelines ?? []) {
    for (const step of p.steps ?? []) {
      for (const r of step.references ?? []) {
        if (r === templateId) {
          out.push({
            fromKind: 'pipeline',
            fromId: p.id,
            field: `steps[${step.id}].references`,
          });
        }
      }
    }
  }
  // Presets that include this template.
  for (const preset of ctx.presets ?? []) {
    const templates = (preset as unknown as { templates?: readonly { id: string }[] }).templates;
    if (templates) {
      for (const t of templates) {
        if (t.id === templateId) {
          out.push({ fromKind: 'preset', fromId: preset.id, field: 'templates' });
        }
      }
    }
    const includes = (preset as unknown as { includes?: { templateIds?: readonly string[] } }).includes;
    if (includes?.templateIds) {
      for (const id of includes.templateIds) {
        if (id === templateId) {
          out.push({
            fromKind: 'preset',
            fromId: preset.id,
            field: 'includes.templateIds',
          });
        }
      }
    }
  }
  // Pack ownership (informational — a pack-owned template requires editing the pack).
  if (ctx.packTemplateIds && ctx.packTemplateIds.has(templateId)) {
    out.push({
      fromKind: 'pack',
      fromId: ctx.packTemplateIds.get(templateId)!,
      field: 'pack-contributed',
      note: 'template is contributed by a pack — removal must happen in the pack source',
    });
  }
  return out;
}

function buildUpdateDraftBody(next: ITemplateDefinition, opId: string): string {
  const constName = idToConst(next.id);
  // We can't faithfully reproduce the `files` / `changes` / `targetPath` /
  // `content` resolvers — they're typically functions. The draft shows the
  // metadata fields only; the user merges them into the existing const.
  const lines: string[] = [];
  lines.push(`// Generated by \`shrk templates ${opId}\` (preview only — not yet written).`);
  lines.push(`// Replace the EXISTING template literal for \`${next.id}\` in your`);
  lines.push(`// templates source file with the metadata fields below.`);
  lines.push(`// Runtime resolvers (\`files\` / \`changes\` / \`targetPath\` / \`content\`)`);
  lines.push(`// are not represented here — keep your existing implementation.`);
  lines.push('');
  lines.push(`export const ${constName}: Partial<ITemplateDefinition> = {`);
  lines.push(`  id: ${JSON.stringify(next.id)},`);
  lines.push(`  name: ${JSON.stringify(next.name)},`);
  lines.push(`  description: ${JSON.stringify(next.description)},`);
  lines.push(`  tags: ${JSON.stringify(next.tags)},`);
  lines.push(`  scope: ${JSON.stringify(next.scope)},`);
  lines.push(`  appliesWhen: ${JSON.stringify(next.appliesWhen)},`);
  if (next.related && next.related.length > 0) {
    lines.push(`  related: ${JSON.stringify(next.related)},`);
  }
  if (next.postGenerationNotes && next.postGenerationNotes.length > 0) {
    lines.push(`  postGenerationNotes: ${JSON.stringify(next.postGenerationNotes, null, 2).split('\n').join('\n  ')},`);
  }
  if (next.metadata) {
    lines.push(
      `  metadata: ${JSON.stringify(next.metadata, null, 2).split('\n').join('\n  ')},`,
    );
  }
  lines.push(`};`);
  lines.push('');
  return lines.join('\n');
}

function buildRemovalNoticeBody(current: ITemplateDefinition): string {
  return (
    `# Template removal preview — ${current.id}\n` +
    `\n` +
    `To remove this template, delete the matching template literal from\n` +
    `your templates source file. Look for the entry with:\n` +
    `\n` +
    `    id: ${JSON.stringify(current.id)},\n` +
    `    name: ${JSON.stringify(current.name)},\n` +
    `\n` +
    `After removing, run \`shrk templates drift --min-severity warning\` and\n` +
    `\`shrk self-config doctor\` to confirm nothing references the deleted id.\n`
  );
}

function buildExplainer(
  input: ITemplateAuthoringInput,
  result: Pick<
    ITemplateAuthoringResult,
    'ok' | 'operation' | 'templateId' | 'refusal' | 'reverseReferences' | 'nextCommands'
  >,
): string {
  const lines: string[] = [];
  lines.push(`# Template authoring preview — ${result.operation} ${result.templateId}`);
  lines.push('');
  if (!result.ok) {
    lines.push(`> Refused: ${result.refusal ?? 'unknown reason'}.`);
    lines.push('');
  }
  lines.push(`Generated: ${nowIso()}`);
  lines.push('');
  lines.push('## What this preview is');
  lines.push('');
  lines.push(
    'Preview-only. Nothing was written to `sharkcraft/templates.ts` or to ' +
      "any pack's `assets/templates.ts`. The draft on disk is for review only.",
  );
  lines.push('');
  if (input.reason) {
    lines.push('## Reason');
    lines.push('');
    lines.push(input.reason);
    lines.push('');
  }
  if (result.reverseReferences && result.reverseReferences.length > 0) {
    lines.push('## Reverse references');
    lines.push('');
    for (const r of result.reverseReferences) {
      lines.push(`- **${r.fromKind}** \`${r.fromId}\` → \`${r.field}\`${r.note ? ` — ${r.note}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Next commands');
  lines.push('');
  for (const c of result.nextCommands) lines.push(`- \`${c}\``);
  lines.push('');
  return lines.join('\n');
}

function nextCommandsForUpdate(): string[] {
  return [
    '# Replace the existing template literal with the metadata fields in the draft.',
    'shrk templates drift --min-severity warning',
    'shrk self-config doctor',
    'shrk packs signature-status',
  ];
}

function nextCommandsForRemove(): string[] {
  return [
    '# Delete the template literal from the templates source file.',
    'shrk templates drift --min-severity warning',
    'shrk self-config doctor',
    'shrk packs signature-status',
  ];
}

function emptyDraftFile(
  id: string,
  op: TemplateAuthoringOperation,
  language: 'typescript' | 'markdown',
): ITemplateAuthoringDraftFile {
  const slug = fileSafeId(id);
  const ext = language === 'typescript' ? 'draft.ts' : 'md';
  return {
    path: `.sharkcraft/authoring/templates/template-${op}-${slug}.${ext}`,
    body: '',
    language,
  };
}

export function buildTemplateAuthoringPreview(
  input: ITemplateAuthoringInput,
  context: ITemplateAuthoringContext,
): ITemplateAuthoringResult {
  const warnings: string[] = [];
  const existing = context.templates.find((t) => t.id === input.id);
  const slug = fileSafeId(input.id);

  if (!existing) {
    const refused: ITemplateAuthoringResult = {
      schema: TEMPLATE_AUTHORING_SCHEMA,
      generatedAt: nowIso(),
      operation: input.operation,
      templateId: input.id,
      ok: false,
      refusal:
        input.operation === TemplateAuthoringOperation.Update
          ? `No template with id "${input.id}" exists. Use \`shrk templates scaffold --id ${input.id}\` to create a new one.`
          : `No template with id "${input.id}" exists — nothing to remove.`,
      tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
      explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
      warnings,
      nextCommands:
        input.operation === TemplateAuthoringOperation.Update
          ? [`shrk templates scaffold --id ${input.id}`]
          : [],
    };
    refused.tsDraft = {
      path: `.sharkcraft/authoring/templates/template-${input.operation}-${slug}.draft.ts`,
      body: `// Refused — template "${input.id}" does not exist.\n`,
      language: 'typescript',
    };
    refused.explainer = {
      path: `.sharkcraft/authoring/templates/template-${input.operation}-${slug}.md`,
      body: buildExplainer(input, refused),
      language: 'markdown',
    };
    return refused;
  }

  switch (input.operation) {
    case TemplateAuthoringOperation.Update: {
      const changes: ITemplateAuthoringPatchChange[] = [];
      const next = applyTemplateUpdateOps(existing, input.updateOps ?? {}, changes);
      if (changes.length === 0) {
        warnings.push('No update ops produced changes. Preview will mirror the current metadata.');
      }
      const result: ITemplateAuthoringResult = {
        schema: TEMPLATE_AUTHORING_SCHEMA,
        generatedAt: nowIso(),
        operation: input.operation,
        templateId: input.id,
        ok: true,
        tsDraft: {
          path: `.sharkcraft/authoring/templates/template-update-${slug}.draft.ts`,
          body: buildUpdateDraftBody(next, 'update'),
          language: 'typescript',
        },
        explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
        warnings,
        nextCommands: nextCommandsForUpdate(),
        current: existing,
        next,
        patch: {
          schema: 'sharkcraft.template-authoring-patch/v1',
          operation: input.operation,
          templateId: input.id,
          changes,
        },
      };
      result.explainer = {
        path: `.sharkcraft/authoring/templates/template-update-${slug}.md`,
        body: buildExplainer(input, result),
        language: 'markdown',
      };
      return result;
    }
    case TemplateAuthoringOperation.Remove: {
      const reverseReferences = findReverseReferences(input.id, context);
      if (reverseReferences.length > 0 && !input.forcePreview) {
        const refused: ITemplateAuthoringResult = {
          schema: TEMPLATE_AUTHORING_SCHEMA,
          generatedAt: nowIso(),
          operation: input.operation,
          templateId: input.id,
          ok: false,
          refusal: `Refused: ${reverseReferences.length} reference(s) point at "${input.id}". Pass --force-preview to preview removal anyway, or update those references first.`,
          tsDraft: emptyDraftFile(input.id, input.operation, 'typescript'),
          explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
          warnings,
          reverseReferences,
          current: existing,
          nextCommands: [
            `# Update each reference to a different template, then re-run.`,
            `shrk templates remove ${input.id} --force-preview --reason "<why>"`,
          ],
        };
        refused.tsDraft = {
          path: `.sharkcraft/authoring/templates/template-remove-${slug}.draft.ts`,
          body: `// Refused — ${reverseReferences.length} reverse reference(s).\n`,
          language: 'typescript',
        };
        refused.explainer = {
          path: `.sharkcraft/authoring/templates/template-remove-${slug}.md`,
          body: buildExplainer(input, refused),
          language: 'markdown',
        };
        return refused;
      }
      const result: ITemplateAuthoringResult = {
        schema: TEMPLATE_AUTHORING_SCHEMA,
        generatedAt: nowIso(),
        operation: input.operation,
        templateId: input.id,
        ok: true,
        tsDraft: {
          path: `.sharkcraft/authoring/templates/template-remove-${slug}.draft.ts`,
          body: `// Template removal notice for ${existing.id} — see .md file for details.\n`,
          language: 'typescript',
        },
        explainer: emptyDraftFile(input.id, input.operation, 'markdown'),
        warnings,
        reverseReferences,
        current: existing,
        patch: {
          schema: 'sharkcraft.template-authoring-patch/v1',
          operation: input.operation,
          templateId: input.id,
          changes: [{ op: 'remove', field: '*', before: { id: existing.id, name: existing.name } }],
        },
        nextCommands: nextCommandsForRemove(),
      };
      const removalBody = buildRemovalNoticeBody(existing) + '\n' +
        buildExplainer(input, result);
      result.explainer = {
        path: `.sharkcraft/authoring/templates/template-remove-${slug}.md`,
        body: removalBody,
        language: 'markdown',
      };
      return result;
    }
  }
}
