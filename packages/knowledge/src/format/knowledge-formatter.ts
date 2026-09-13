import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import { todayUtcIso, verifiedOnAgeDays } from '../verify/verified-on.ts';
import { formatEntryActionHints } from './action-hints-formatter.ts';
import type { IKnowledgeRefResolution } from './i-knowledge-ref-resolution.ts';

export interface FormatEntryOptions {
  includeExamples?: boolean;
  includeContent?: boolean;
  includeMetadata?: boolean;
  includeActionHints?: boolean;
  maxContentChars?: number;
  /** The date `verifiedOn` ages are measured to (`YYYY-MM-DD`). Default: today (UTC). */
  asOf?: string;
  /**
   * Resolves a cross-reference id (`supersededBy` / `seeAlso` / `related`) to
   * the namespace(s) it lives in. Injected — this package sits below the
   * reference registry. Without one, ids print plain.
   */
  resolveRef?: (id: string) => IKnowledgeRefResolution | undefined;
}

/** The string ids a cross-reference field holds (a scalar is honoured as one id). */
function crossRefIds(value: unknown): string[] {
  if (typeof value === 'string') return value.trim().length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/** `id (rule | knowledge — "Title")`, `id (UNRESOLVED — …)`, or the bare id with no resolver. */
function crossRefLabel(
  id: string,
  resolveRef: FormatEntryOptions['resolveRef'],
): { label: string; resolved: boolean } {
  if (!resolveRef) return { label: id, resolved: true };
  const r = resolveRef(id);
  if (r?.unverified) return { label: `${id} (NOT VERIFIED — registries not warmed)`, resolved: false };
  if (!r || r.kinds.length === 0) return { label: `${id} (UNRESOLVED — no registry has this id)`, resolved: false };
  return { label: `${id} (${r.kinds.join(' | ')}${r.title ? ` — "${r.title}"` : ''})`, resolved: true };
}

/**
 * A list field read defensively. The TypeScript loader normalises
 * `tags` / `scope` / `appliesWhen`, but an entry built any other way (a frozen
 * literal, a hand-rolled fixture, a future loader) must not crash a renderer.
 */
function listOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value : [];
}

export function formatEntryCompact(entry: IKnowledgeEntry): string {
  const tagList = listOf(entry.tags);
  const scopeList = listOf(entry.scope);
  const whenList = listOf(entry.appliesWhen);
  const tags = tagList.length ? ` tags=[${tagList.join(', ')}]` : '';
  const scope = scopeList.length ? ` scope=[${scopeList.join(', ')}]` : '';
  const appliesWhen = whenList.length ? ` appliesWhen=[${whenList.join(', ')}]` : '';
  return `${entry.id} (${entry.type}, ${entry.priority}) — ${entry.title}${tags}${scope}${appliesWhen}`;
}

/**
 * Project an entry to a plain JSON-serialisable object by reading each declared
 * `IKnowledgeEntry` field by DIRECT property access.
 *
 * Spreading (`{ ...entry }`) copies only own-enumerable properties, so a
 * pack-contributed entry whose fields are getters / non-enumerable /
 * prototype-backed would serialise to `{ id, source }` only — the JSON looked
 * "empty" while the text form (which reads fields directly) was complete.
 * Direct access matches the text path and is robust to the entry's property
 * descriptors. Undefined optionals drop out of `JSON.stringify` naturally.
 */
export function projectKnowledgeEntryForJson(entry: IKnowledgeEntry): Record<string, unknown> {
  return {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    priority: entry.priority,
    scope: entry.scope,
    tags: entry.tags,
    appliesWhen: entry.appliesWhen,
    content: entry.content,
    summary: entry.summary,
    examples: entry.examples,
    related: entry.related,
    source: entry.source,
    metadata: entry.metadata,
    actionHints: entry.actionHints,
    references: entry.references,
    anchors: entry.anchors,
    verifiedOn: entry.verifiedOn,
    seeAlso: entry.seeAlso,
    supersededBy: entry.supersededBy,
  };
}

/** `verifiedOn: 2026-05-01 (133d ago)` — or why the date could not be aged. */
function verifiedOnLine(verifiedOn: string, asOf: string): string {
  const age = verifiedOnAgeDays(verifiedOn, asOf);
  if (age === undefined) return `verifiedOn: ${verifiedOn} (not a valid YYYY-MM-DD date)`;
  if (age < 0) return `verifiedOn: ${verifiedOn} (${-age}d after ${asOf})`;
  return `verifiedOn: ${verifiedOn} (${age}d ago)`;
}

export function formatEntryFull(
  entry: IKnowledgeEntry,
  options: FormatEntryOptions = {},
): string {
  const { includeExamples = true, includeContent = true, maxContentChars } = options;
  const lines: string[] = [];
  lines.push(`# ${entry.title}`);
  lines.push(`id: ${entry.id}`);
  // Directly under the id, before any content a reader might act on: a
  // superseded entry routes them to the current one instead of leaving it to
  // prose ("see X instead") that may point into a dead id.
  for (const successor of crossRefIds(entry.supersededBy)) {
    const { label, resolved } = crossRefLabel(successor, options.resolveRef);
    lines.push(`SUPERSEDED by: ${label}${resolved ? `  →  shrk knowledge get ${successor}` : ''}`);
  }
  lines.push(`type: ${entry.type}`);
  lines.push(`priority: ${entry.priority}`);
  const scopeList = listOf(entry.scope);
  const tagList = listOf(entry.tags);
  const whenList = listOf(entry.appliesWhen);
  if (scopeList.length) lines.push(`scope: ${scopeList.join(', ')}`);
  if (tagList.length) lines.push(`tags: ${tagList.join(', ')}`);
  if (whenList.length) lines.push(`appliesWhen: ${whenList.join(', ')}`);
  if (entry.verifiedOn) lines.push(verifiedOnLine(entry.verifiedOn, options.asOf ?? todayUtcIso()));
  if (entry.summary) {
    lines.push('');
    lines.push(`Summary: ${entry.summary}`);
  }
  if (includeContent) {
    lines.push('');
    let content = entry.content.trim();
    if (maxContentChars && content.length > maxContentChars) {
      content = content.slice(0, maxContentChars) + '…';
    }
    lines.push(content);
  }
  if (includeExamples && entry.examples?.length) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of entry.examples) {
      if (ex.title) lines.push(`- ${ex.title}`);
      if (ex.description) lines.push(`  ${ex.description}`);
      if (ex.code) {
        const lang = ex.language ?? '';
        lines.push('  ```' + lang);
        for (const codeLine of ex.code.split('\n')) lines.push('  ' + codeLine);
        lines.push('  ```');
      }
    }
  }
  for (const [heading, ids] of [
    ['See also:', crossRefIds(entry.seeAlso)],
    ['Related:', crossRefIds(entry.related)],
  ] as const) {
    if (ids.length === 0) continue;
    lines.push('');
    lines.push(heading);
    for (const id of ids) lines.push(`- ${crossRefLabel(id, options.resolveRef).label}`);
  }
  if (options.includeActionHints !== false && entry.actionHints) {
    const block = formatEntryActionHints(entry, { level: '###', compact: true });
    if (block) {
      lines.push('');
      lines.push(block);
    }
  }
  return lines.join('\n');
}
