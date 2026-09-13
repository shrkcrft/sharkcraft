import { extname } from 'node:path';
import type { IKnowledgeEntry } from './knowledge-entry.ts';
import { KnowledgeSourceFormat } from './knowledge-source-format.ts';

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

/**
 * THE answer to "what format was this entry declared in?" — the loader that
 * produced it (`source.loader`, set by both file loaders), else the origin's
 * extension. The stale-check remedy, the validator's hint and `custom-checks`
 * read it, so they cannot disagree about a file.
 */
export function knowledgeSourceFormat(entry: Pick<IKnowledgeEntry, 'source'>): KnowledgeSourceFormat {
  const loader = entry.source?.loader;
  if (loader === 'markdown') return KnowledgeSourceFormat.Markdown;
  if (loader === 'typescript') return KnowledgeSourceFormat.TypeScript;
  const ext = extname(entry.source?.origin ?? '').toLowerCase();
  if (ext === '.md') return KnowledgeSourceFormat.Markdown;
  if (TYPESCRIPT_EXTENSIONS.has(ext)) return KnowledgeSourceFormat.TypeScript;
  return KnowledgeSourceFormat.Other;
}
