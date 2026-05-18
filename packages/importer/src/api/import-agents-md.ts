import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IImportResult } from '../model/import-result.ts';
import { parseMarkdownRules } from '../parse/parse-markdown-rules.ts';

export interface IImportAgentsMdOptions {
  /** Absolute or relative path to AGENTS.md. */
  filePath: string;
  /** Project root (used to relativize origin paths in the result). */
  projectRoot?: string;
  /** Override the entry id prefix. Defaults to "agents". */
  idPrefix?: string;
  /** Extra tags appended to every produced entry. */
  extraTags?: readonly string[];
  /** Scope tokens appended to every produced entry. */
  scope?: readonly string[];
}

export function importAgentsMd(options: IImportAgentsMdOptions): IImportResult {
  const root = options.projectRoot ?? process.cwd();
  const file = nodePath.isAbsolute(options.filePath)
    ? options.filePath
    : nodePath.resolve(root, options.filePath);
  if (!existsSync(file)) {
    return {
      format: 'agents-md',
      sourceFiles: [],
      entries: [],
      warnings: [{ origin: options.filePath, message: 'File does not exist.' }],
    };
  }
  const raw = readFileSync(file, 'utf8');
  const origin = nodePath.relative(root, file) || nodePath.basename(file);
  const entries = parseMarkdownRules(raw, {
    origin,
    idPrefix: options.idPrefix ?? 'agents',
  }).map((e) => ({
    ...e,
    tags: [...new Set([...e.tags, ...(options.extraTags ?? []), ...(options.scope ?? [])])],
  }));
  const warnings = entries.length === 0
    ? [{ origin, message: 'No bullet rules or headed paragraphs found.' }]
    : [];
  return {
    format: 'agents-md',
    sourceFiles: [origin],
    entries,
    warnings,
  };
}
