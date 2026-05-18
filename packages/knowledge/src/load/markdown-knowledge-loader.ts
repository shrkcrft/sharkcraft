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
    const baseName = basename(filePath, '.md');
    const titleFromBody = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();

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
    };

    entries.push(entry);
    return { entries, warnings, sourceFiles };
  }
}
