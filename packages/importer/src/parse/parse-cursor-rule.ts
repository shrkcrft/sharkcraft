import { KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';
import type { IImportedEntry } from '../model/imported-entry.ts';
import { keywordTags, slugify } from './slugify.ts';

/**
 * Parse a single .cursor/rules/*.mdc file. MDC format = YAML frontmatter
 * (between `---` markers) + markdown body. We extract:
 *   - `description` → entry title
 *   - `globs` / `tags` → tags
 *   - `priority` (if present) → KnowledgePriority
 *   - the body → content
 */
export interface ICursorRuleOptions {
  origin: string;
  idPrefix: string;
}

interface IFrontmatter {
  description?: string;
  tags?: string[];
  globs?: string[];
  priority?: string;
  alwaysApply?: boolean;
}

function parseFrontmatter(raw: string): { fm: IFrontmatter; body: string } {
  // Normalize CRLF/CR first: otherwise a trailing `\r` breaks the `\n---`
  // separator offset math AND the `key: (.*)$` regex (`$` won't span `\r`),
  // dropping description/globs/tags on a Windows-authored .mdc file.
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: text };
  const block = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const fm: IFrontmatter = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    // Strip wrapping quotes / brackets.
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (key === 'tags' || key === 'globs') {
      const list = value.replace(/^\[|\]$/g, '').split(',').map((s) =>
        s.trim().replace(/^['"]|['"]$/g, ''),
      );
      (fm as Record<string, unknown>)[key] = list.filter(Boolean);
    } else if (key === 'alwaysApply') {
      fm.alwaysApply = value.toLowerCase() === 'true';
    } else {
      (fm as Record<string, unknown>)[key] = value;
    }
  }
  return { fm, body };
}

function priorityFromString(input: string | undefined): KnowledgePriority {
  switch ((input ?? '').toLowerCase()) {
    case 'critical':
      return KnowledgePriority.Critical;
    case 'high':
      return KnowledgePriority.High;
    case 'low':
      return KnowledgePriority.Low;
    default:
      return KnowledgePriority.Medium;
  }
}

export function parseCursorRuleFile(
  raw: string,
  options: ICursorRuleOptions,
): IImportedEntry {
  const { fm, body } = parseFrontmatter(raw);
  const title = fm.description ?? body.split('\n').find((l) => l.trim().length > 0) ?? options.idPrefix;
  const baseSlug = slugify(title) || slugify(options.idPrefix);
  const tags = [
    ...new Set([
      ...(fm.tags ?? []),
      ...(fm.globs ?? []).map((g) => g.replace(/[*?]/g, '')).map((g) => slugify(g)).filter(Boolean),
      ...keywordTags(title),
    ]),
  ];
  return {
    id: `${options.idPrefix}.${baseSlug}`,
    title: title.slice(0, 100),
    type: KnowledgeType.Rule,
    priority: priorityFromString(fm.priority),
    section: 'cursor-rules',
    tags,
    content: body.trim(),
    origin: options.origin,
  };
}
