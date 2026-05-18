import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IImportedEntry } from '../model/imported-entry.ts';
import type { IImportResult, IImportWarning } from '../model/import-result.ts';
import { parseCursorRuleFile } from '../parse/parse-cursor-rule.ts';
import { slugify } from '../parse/slugify.ts';

export interface IImportCursorRulesOptions {
  /** Path to .cursor/rules directory OR a single .mdc file. */
  filePath: string;
  projectRoot?: string;
  /** Override id prefix (per-file slug still appended). Defaults to "cursor". */
  idPrefix?: string;
  /** Extra tags appended to every produced entry. */
  extraTags?: readonly string[];
  /** Scope tokens appended to every produced entry. */
  scope?: readonly string[];
}

function walkMdcFiles(start: string): string[] {
  const out: string[] = [];
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    let stat;
    try {
      stat = statSync(cur);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (cur.endsWith('.mdc') || cur.endsWith('.md')) out.push(cur);
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) stack.push(nodePath.join(cur, name));
  }
  return out.sort();
}

export function importCursorRules(options: IImportCursorRulesOptions): IImportResult {
  const root = options.projectRoot ?? process.cwd();
  const target = nodePath.isAbsolute(options.filePath)
    ? options.filePath
    : nodePath.resolve(root, options.filePath);
  if (!existsSync(target)) {
    return {
      format: 'cursor-rules',
      sourceFiles: [],
      entries: [],
      warnings: [{ origin: options.filePath, message: 'File or directory does not exist.' }],
    };
  }
  const files = walkMdcFiles(target);
  const entries: IImportedEntry[] = [];
  const warnings: IImportWarning[] = [];
  const seenIds = new Set<string>();
  const basePrefix = options.idPrefix ?? 'cursor';
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const origin = nodePath.relative(root, file) || nodePath.basename(file);
    const base = nodePath.basename(file).replace(/\.(mdc|md)$/i, '');
    const idPrefix = `${basePrefix}.${slugify(base) || 'rule'}`;
    const entry = parseCursorRuleFile(raw, { origin, idPrefix });
    let id = entry.id;
    let counter = 2;
    while (seenIds.has(id)) {
      id = `${entry.id}-${counter}`;
      counter += 1;
    }
    seenIds.add(id);
    const tags = [
      ...new Set([
        ...entry.tags,
        ...(options.extraTags ?? []),
        ...(options.scope ?? []),
      ]),
    ];
    entries.push({ ...entry, id, tags });
  }
  if (files.length === 0) {
    warnings.push({
      origin: nodePath.relative(root, target) || target,
      message: 'No .mdc / .md files found under target.',
    });
  }
  return {
    format: 'cursor-rules',
    sourceFiles: files.map((f) => nodePath.relative(root, f) || f),
    entries,
    warnings,
  };
}
