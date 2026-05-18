import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import { formatEntryActionHints } from './action-hints-formatter.ts';

export interface FormatEntryOptions {
  includeExamples?: boolean;
  includeContent?: boolean;
  includeMetadata?: boolean;
  includeActionHints?: boolean;
  maxContentChars?: number;
}

export function formatEntryCompact(entry: IKnowledgeEntry): string {
  const tags = entry.tags.length ? ` tags=[${entry.tags.join(', ')}]` : '';
  const scope = entry.scope.length ? ` scope=[${entry.scope.join(', ')}]` : '';
  const appliesWhen = entry.appliesWhen.length ? ` appliesWhen=[${entry.appliesWhen.join(', ')}]` : '';
  return `${entry.id} (${entry.type}, ${entry.priority}) — ${entry.title}${tags}${scope}${appliesWhen}`;
}

export function formatEntryFull(
  entry: IKnowledgeEntry,
  options: FormatEntryOptions = {},
): string {
  const { includeExamples = true, includeContent = true, maxContentChars } = options;
  const lines: string[] = [];
  lines.push(`# ${entry.title}`);
  lines.push(`id: ${entry.id}`);
  lines.push(`type: ${entry.type}`);
  lines.push(`priority: ${entry.priority}`);
  if (entry.scope.length) lines.push(`scope: ${entry.scope.join(', ')}`);
  if (entry.tags.length) lines.push(`tags: ${entry.tags.join(', ')}`);
  if (entry.appliesWhen.length) lines.push(`appliesWhen: ${entry.appliesWhen.join(', ')}`);
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
  if (options.includeActionHints !== false && entry.actionHints) {
    const block = formatEntryActionHints(entry, { level: '###', compact: true });
    if (block) {
      lines.push('');
      lines.push(block);
    }
  }
  return lines.join('\n');
}
