import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type { ILoadedKnowledge, IKnowledgeLoader } from './knowledge-loader.ts';
import { KnowledgeType } from '../model/knowledge-type.ts';
import { KnowledgePriority } from '../model/knowledge-priority.ts';
import { normalizeKnowledgeId, toKebabCase } from '@shrkcrft/core';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

interface Frontmatter {
  id?: string;
  title?: string;
  type?: string;
  priority?: string;
  scope?: string | string[];
  tags?: string | string[];
  appliesWhen?: string | string[];
  summary?: string;
  related?: string | string[];
  /** `YYYY-MM-DD` — the day an author last checked this entry against the code. */
  verifiedOn?: string | string[];
  /** Ids of any kind a reader should also look at (`seeAlso:` or `see-also:`). */
  seeAlso?: string | string[];
  'see-also'?: string | string[];
  /** Knowledge ids that replace this entry (`supersededBy:` or `superseded-by:`). */
  supersededBy?: string | string[];
  'superseded-by'?: string | string[];
}

function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { meta: {}, body: text };
  const block = match[1] ?? '';
  const body = text.slice(match[0].length);
  const meta: Frontmatter = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value: string | string[] = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
    } else if (value.startsWith('"') || value.startsWith("'")) {
      value = value.replace(/^["']|["']$/g, '');
    }
    (meta as Record<string, unknown>)[key] = value;
  }
  return { meta, body };
}

/**
 * The frontmatter keys this loader maps onto the entry. Every other key is
 * parsed and then dropped — so {@link unsupportedFrontmatterKeys} names it and
 * the loader warns, instead of the value vanishing silently.
 */
const ENTRY_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'type',
  'priority',
  'scope',
  'tags',
  'appliesWhen',
  'summary',
  'related',
  'verifiedOn',
  'seeAlso',
  'see-also',
  'supersededBy',
  'superseded-by',
]);

/**
 * Every TOP-LEVEL frontmatter key this loader does NOT carry onto the entry, in
 * file order, each with its raw block (the key line plus the indented lines
 * under it). THE answer to "what did the Markdown loader drop?" — the loader's
 * warnings and the custom-checks registry (a Markdown rule whose `metadata`
 * held `checks`) both read it, so the two cannot disagree.
 *
 * `metadata` is the notable one: a Markdown rule cannot carry
 * `metadata.checks[]` (or any metadata) — only a TypeScript entry can.
 */
export function unsupportedFrontmatterKeys(
  text: string,
): readonly { readonly key: string; readonly block: string }[] {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return [];
  const out: { key: string; block: string }[] = [];
  let current: { key: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (current) out.push({ key: current.key, block: current.lines.join('\n') });
    current = null;
  };
  for (const line of (match[1] ?? '').split('\n')) {
    // An unindented `key:` line opens a block; indented lines, list items and
    // comments belong to whatever block is open.
    const topLevel = line.length > 0 && !/^\s/.test(line) && !line.startsWith('-') && !line.startsWith('#');
    if (!topLevel) {
      current?.lines.push(line);
      continue;
    }
    flush();
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (ENTRY_FRONTMATTER_KEYS.has(key) || out.some((o) => o.key === key)) continue;
    current = { key, lines: [line] };
  }
  flush();
  return out;
}

function unsupportedKeyWarning(filePath: string, key: string): string {
  if (key === 'metadata') {
    return (
      `${filePath}: frontmatter key "metadata" was dropped — the Markdown loader does not support metadata; ` +
      'attach metadata (e.g. metadata.checks) in a TypeScript rule file'
    );
  }
  return (
    `${filePath}: frontmatter key "${key}" was dropped — it is not a field the Markdown loader reads ` +
    `(reads: ${[...ENTRY_FRONTMATTER_KEYS].join(', ')})`
  );
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export class MarkdownKnowledgeLoader implements IKnowledgeLoader {
  canLoad(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.md';
  }

  async load(filePath: string): Promise<ILoadedKnowledge> {
    const warnings: string[] = [];
    const entries: IKnowledgeEntry[] = [];
    const sourceFiles: string[] = [];

    if (!existsSync(filePath)) {
      warnings.push(`Markdown file not found: ${filePath}`);
      return { entries, warnings, sourceFiles };
    }

    sourceFiles.push(filePath);

    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (e) {
      warnings.push(`Failed to read ${filePath}: ${(e as Error).message}`);
      return { entries, warnings, sourceFiles };
    }

    const { meta, body } = parseFrontmatter(text);
    // Parsed-then-dropped keys used to vanish without a word; the entry shape
    // is unchanged, the drop is now said out loud.
    for (const { key } of unsupportedFrontmatterKeys(text)) warnings.push(unsupportedKeyWarning(filePath, key));
    const baseName = basename(filePath, '.md');
    const titleFromBody = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    // Both spellings: YAML authors reach for kebab-case keys.
    const seeAlso = toArray(meta.seeAlso ?? meta['see-also']);
    const supersededBy = toArray(meta.supersededBy ?? meta['superseded-by']);

    const entry: IKnowledgeEntry = {
      id: meta.id ? normalizeKnowledgeId(meta.id) : `doc.${toKebabCase(baseName)}`,
      title: meta.title || titleFromBody || baseName,
      type: meta.type || KnowledgeType.Technical,
      priority: meta.priority || KnowledgePriority.Medium,
      scope: Object.freeze(toArray(meta.scope)),
      tags: Object.freeze(toArray(meta.tags).length > 0 ? toArray(meta.tags) : ['markdown', 'doc']),
      appliesWhen: Object.freeze(toArray(meta.appliesWhen)),
      content: body.trim(),
      summary: meta.summary,
      related: meta.related ? Object.freeze(toArray(meta.related)) : undefined,
      source: { origin: filePath, loader: 'markdown' },
      // Carried verbatim; the validator (not the loader) decides whether it is a
      // real date, so a typo surfaces as an `invalid-verified-on` issue instead
      // of vanishing.
      ...(typeof meta.verifiedOn === 'string' && meta.verifiedOn.length > 0
        ? { verifiedOn: meta.verifiedOn }
        : {}),
      ...(seeAlso.length > 0 ? { seeAlso: Object.freeze(seeAlso) } : {}),
      ...(supersededBy.length > 0 ? { supersededBy: Object.freeze(supersededBy) } : {}),
    };

    entries.push(entry);
    return { entries, warnings, sourceFiles };
  }
}
