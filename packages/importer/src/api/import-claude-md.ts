import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IImportResult } from '../model/import-result.ts';
import { parseMarkdownRules } from '../parse/parse-markdown-rules.ts';

export interface IImportClaudeMdOptions {
  /** Path to CLAUDE.md (absolute or relative to projectRoot). */
  filePath: string;
  projectRoot?: string;
  idPrefix?: string;
  extraTags?: readonly string[];
  scope?: readonly string[];
}

export function importClaudeMd(options: IImportClaudeMdOptions): IImportResult {
  const root = options.projectRoot ?? process.cwd();
  const file = nodePath.isAbsolute(options.filePath)
    ? options.filePath
    : nodePath.resolve(root, options.filePath);
  if (!existsSync(file)) {
    return {
      format: 'claude-md',
      sourceFiles: [],
      entries: [],
      warnings: [{ origin: options.filePath, message: 'File does not exist.' }],
    };
  }
  const raw = readFileSync(file, 'utf8');
  const origin = nodePath.relative(root, file) || nodePath.basename(file);
  const entries = parseMarkdownRules(raw, {
    origin,
    idPrefix: options.idPrefix ?? 'claude',
  }).map((e) => ({
    ...e,
    tags: [...new Set([...e.tags, ...(options.extraTags ?? []), ...(options.scope ?? [])])],
  }));
  return {
    format: 'claude-md',
    sourceFiles: [origin],
    entries,
    warnings: entries.length === 0
      ? [{ origin, message: 'No bullet rules or headed paragraphs found.' }]
      : [],
  };
}
