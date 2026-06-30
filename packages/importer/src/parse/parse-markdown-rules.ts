import { KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';
import type { IImportedEntry } from '../model/imported-entry.ts';
import { keywordTags, slugify } from './slugify.ts';

/**
 * Generic markdown-rules parser. Walks H1/H2/H3 sections; treats:
 *   - top-level bullets under a heading as separate rules
 *   - non-bullet paragraphs as a single rule with the heading as title
 *
 * Conservatively maps headings to knowledge types: "path"/"location" →
 * PathConvention, "architecture"/"layer" → Architecture, "task"/"todo" → Task,
 * everything else → Rule.
 */
export interface IMarkdownParseOptions {
  /** Origin tag stamped onto every produced entry. */
  origin: string;
  /** Prefix for derived ids (e.g. "claude" → "claude.rule.<slug>"). */
  idPrefix: string;
}

interface IPendingSection {
  heading: string;
  level: number;
  paragraphs: string[];
}

const PRIORITY_PATTERNS: { pattern: RegExp; value: KnowledgePriority }[] = [
  { pattern: /\b(critical|never|must not|forbidden|do not)\b/i, value: KnowledgePriority.Critical },
  { pattern: /\b(must|required|always|do)\b/i, value: KnowledgePriority.High },
  { pattern: /\b(should|prefer)\b/i, value: KnowledgePriority.Medium },
  { pattern: /\b(may|optional|nice to have)\b/i, value: KnowledgePriority.Low },
];

function inferPriority(text: string): KnowledgePriority {
  for (const { pattern, value } of PRIORITY_PATTERNS) {
    if (pattern.test(text)) return value;
  }
  return KnowledgePriority.Medium;
}

function inferType(heading: string): KnowledgeType {
  const h = heading.toLowerCase();
  if (h.includes('path') || h.includes('layout') || h.includes('location')) {
    return KnowledgeType.Path;
  }
  if (h.includes('architecture') || h.includes('layer')) return KnowledgeType.Architecture;
  if (h.includes('task') || h.includes('todo') || h.includes('roadmap')) return KnowledgeType.Task;
  if (h.includes('decision') || h.includes('adr')) return KnowledgeType.Decision;
  if (h.includes('command')) return KnowledgeType.Command;
  if (h.includes('test')) return KnowledgeType.Testing;
  if (h.includes('security')) return KnowledgeType.Security;
  if (h.includes('deploy')) return KnowledgeType.Deployment;
  if (h.includes('convention')) return KnowledgeType.Convention;
  if (h.includes('workflow')) return KnowledgeType.Workflow;
  return KnowledgeType.Rule;
}

function extractTitle(text: string): string {
  const stripped = text.replace(/\*\*|__|`/g, '').trim();
  const firstLine = stripped.split('\n')[0] ?? '';
  // First sentence up to 80 chars.
  const sentenceEnd = firstLine.search(/[.!?](\s|$)/);
  if (sentenceEnd > 0 && sentenceEnd < 100) {
    return firstLine.slice(0, sentenceEnd).trim();
  }
  return firstLine.slice(0, 80).trim();
}

function bulletsFromBlock(block: string): string[] {
  const lines = block.split('\n');
  const out: string[] = [];
  let current = '';
  for (const line of lines) {
    if (/^[-*]\s+/.test(line)) {
      if (current) out.push(current.trim());
      current = line.replace(/^[-*]\s+/, '');
    } else if (current && (/^\s{2,}/.test(line) || line.trim() === '')) {
      current += '\n' + line;
    }
  }
  if (current) out.push(current.trim());
  return out;
}

export function parseMarkdownRules(
  raw: string,
  options: IMarkdownParseOptions,
): IImportedEntry[] {
  const entries: IImportedEntry[] = [];
  // Normalize CRLF/CR first: a trailing `\r` on each line makes the heading
  // regex `(.*)$` fail (`.`/`$` don't span `\r`), silently dropping every rule
  // in a Windows/mixed-OS file.
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const sections: IPendingSection[] = [];
  let current: IPendingSection | null = null;
  let paragraph: string[] = [];

  const flushPara = (): void => {
    if (paragraph.length === 0) return;
    const block = paragraph.join('\n').trim();
    if (block.length > 0) {
      // Lazily open an implicit preamble section so content before the first
      // heading (intro prose, or a FLAT heading-less bullet list — the most
      // common AGENTS.md shape) is not silently dropped. Empty heading →
      // inferType('') = Rule, keywordTags('') = [], and the falsy heading
      // suppresses the `section` field downstream, so preamble entries are
      // well-formed.
      if (!current) current = { heading: '', level: 0, paragraphs: [] };
      current.paragraphs.push(block);
    }
    paragraph = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushPara();
      if (current) sections.push(current);
      current = { heading: headingMatch[2]!.trim(), level: headingMatch[1]!.length, paragraphs: [] };
      continue;
    }
    paragraph.push(line);
  }
  flushPara();
  if (current) sections.push(current);

  const seen = new Set<string>();
  for (const section of sections) {
    const type = inferType(section.heading);
    const tagsFromHeading = keywordTags(section.heading);

    for (const block of section.paragraphs) {
      const bullets = bulletsFromBlock(block);
      const units = bullets.length > 0 ? bullets : [block];
      for (const unit of units) {
        const title = extractTitle(unit);
        if (!title) continue;
        // `slugify` strips non-ASCII to '', so a CJK/Cyrillic/emoji heading or
        // title can collapse to an empty slug → id `claude.` which FAILS shrk's
        // own isValidKnowledgeId. Fall back to a deterministic non-empty slug.
        const slugBase = slugify(`${section.heading}-${title}`) || slugify(title) || 'entry';
        let id = `${options.idPrefix}.${slugBase}`;
        let counter = 2;
        while (seen.has(id)) {
          id = `${options.idPrefix}.${slugBase}-${counter}`;
          counter += 1;
        }
        seen.add(id);
        const priority = inferPriority(unit);
        const tags = [...new Set([...tagsFromHeading, ...keywordTags(title)])];
        entries.push({
          id,
          title,
          type,
          priority,
          section: section.heading,
          tags,
          content: unit.trim(),
          origin: options.origin,
        });
      }
    }
  }

  return entries;
}
