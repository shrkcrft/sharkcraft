import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { type IImportContext, safeImport } from '@shrkcrft/core';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type { ILoadedKnowledge, IKnowledgeLoader } from './knowledge-loader.ts';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

function isLikelyEntry(value: unknown): value is IKnowledgeEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.title === 'string' && typeof v.content === 'string';
}

function collectEntriesFromModule(
  mod: Record<string, unknown>,
  entries: IKnowledgeEntry[],
  warnings: string[],
): void {
  const seen = new Set<string>();
  const tryPush = (value: unknown): void => {
    if (!isLikelyEntry(value)) return;
    if (seen.has(value.id)) return;
    seen.add(value.id);
    entries.push(value);
  };
  for (const key of Object.keys(mod)) {
    let value: unknown;
    try {
      value = mod[key];
    } catch (e) {
      // A partially-initialized module namespace (e.g. a `default` binding in
      // the temporal dead zone after a previously-errored import) throws on
      // property access. Degrade to a warning rather than a sync crash.
      const message = e instanceof Error ? e.message : String(e);
      warnings.push(`Skipped uninitialized export "${key}": ${message}`);
      continue;
    }
    if (isLikelyEntry(value)) {
      tryPush(value);
    } else if (Array.isArray(value)) {
      for (const item of value) tryPush(item);
    } else if (value && typeof value === 'object' && 'entries' in (value as object)) {
      const inner = (value as { entries?: unknown }).entries;
      if (Array.isArray(inner)) {
        for (const item of inner) tryPush(item);
      }
    }
  }
}

export class TypeScriptKnowledgeLoader implements IKnowledgeLoader {
  private readonly _importContext: IImportContext | undefined;

  constructor(options: { importContext?: IImportContext } = {}) {
    this._importContext = options.importContext;
  }

  canLoad(filePath: string): boolean {
    return TS_EXTENSIONS.has(extname(filePath));
  }

  async load(filePath: string): Promise<ILoadedKnowledge> {
    const warnings: string[] = [];
    const entries: IKnowledgeEntry[] = [];
    const sourceFiles: string[] = [];

    if (!existsSync(filePath)) {
      warnings.push(`Knowledge file not found: ${filePath}`);
      return { entries, warnings, sourceFiles };
    }
    sourceFiles.push(filePath);

    const result = this._importContext
      ? await this._importContext.load(filePath)
      : await safeImport(filePath, { skipExistsCheck: true });

    if (!result.ok) {
      const label = result.timedOut ? 'timed out importing' : 'Failed to import';
      warnings.push(`${label} ${filePath}: ${result.error.message}`);
      return { entries, warnings, sourceFiles };
    }

    collectEntriesFromModule(result.module, entries, warnings);
    for (const entry of entries) {
      if (!entry.source?.origin) {
        (entry as { source?: { origin?: string; loader?: string } }).source = {
          origin: filePath,
          loader: 'typescript',
        };
      }
    }
    if (entries.length === 0) {
      warnings.push(`No knowledge entries detected in ${filePath}`);
    }

    return { entries, warnings, sourceFiles };
  }
}
