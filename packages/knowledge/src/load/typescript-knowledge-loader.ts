import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { type IImportContext, type IRejectedEntry, RejectionCause, safeImport } from '@shrkcrft/core';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import type { ILoadedKnowledge, IKnowledgeLoader } from './knowledge-loader.ts';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

/** The fields THE predicate ({@link isLikelyEntry}) requires, each a string. */
const REQUIRED_STRING_FIELDS = ['id', 'title', 'content'] as const;

/**
 * THE knowledge-entry predicate the loader registers by. Exported so the
 * unregistered-export check asks exactly the question the loader asks.
 */
export function isLikelyEntry(value: unknown): value is IKnowledgeEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.title === 'string' && typeof v.content === 'string';
}

/**
 * Why `value` is not a knowledge entry: one `<field>: <message>` per field
 * {@link isLikelyEntry} requires and `value` lacks — `[]` when it is one. The
 * reasons a rejected entry reports, from THE predicate's own field list.
 */
export function knowledgeEntryRejectionReasons(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['(entry): must be an object'];
  const v = value as Record<string, unknown>;
  return REQUIRED_STRING_FIELDS.filter((f) => typeof v[f] !== 'string').map((f) => `${f}: must be a string`);
}

/** Fields only a knowledge entry carries — a NAMED export's member bearing one is meant as an entry. */
const KNOWLEDGE_ONLY_FIELDS = ['content', 'type', 'priority'] as const;

/**
 * Is `value` plainly MEANT as an entry? Only such a list member (or a
 * `default` object) that fails the predicate is a rejected entry.
 *
 *   - In the `default` export: an object carrying a string `id` or `title`.
 *   - In a NAMED export — where a module keeps its helper values (`export
 *     const TAGS = ['x']`, `export const TAGS = [{ id: 'x', label: 'X' }]`) —
 *     it must ALSO carry two of the required string fields (`id` / `title` /
 *     `content`) or a knowledge-only field (`content` / `type` / `priority`).
 *     An `{ id, label }` lookup row is a helper value, never a rejected entry
 *     (round 12 review, A-3: it failed `self-config doctor` and `packs
 *     contributions` as `knowledge-invalid`).
 */
function isEntryCandidate(value: unknown, named: boolean): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' && typeof v.title !== 'string') return false;
  if (!named) return true;
  const required = REQUIRED_STRING_FIELDS.filter((f) => typeof v[f] === 'string').length;
  return required >= 2 || KNOWLEDGE_ONLY_FIELDS.some((f) => v[f] !== undefined);
}

/**
 * Collect every entry-shaped export of a module. The first OBJECT per id wins;
 * the same object exported twice (`export const a` + `export default [a]`) is
 * one entry, while a DIFFERENT object reusing an id is reported as shadowed
 * (it used to vanish silently). `file` names the module in that warning.
 *
 * With `rejected` (round 12, 12.1), every entry the predicate refuses is
 * RECORDED there — a list member (or the `default` object) meant as an entry
 * that lacks a required field, and a different object reusing an id — so
 * `accepted + rejected === declared` for the file. It used to be dropped with
 * no line on any surface.
 */
export function collectEntriesFromModule(
  mod: Record<string, unknown>,
  entries: IKnowledgeEntry[],
  warnings: string[],
  file?: string,
  rejected?: IRejectedEntry[],
): void {
  const firstById = new Map<string, { value: unknown; key: string }>();
  // `key` locates the value: the export name, plus `[i]` for an array member
  // (`default[3]`), so two members of one array export are told apart. `at` is
  // the same location, structured; `candidate` marks a position where a value
  // that fails the predicate is a REJECTED entry (not a module helper value).
  const tryPush = (
    value: unknown,
    key: string,
    at: { readonly exportName: string; readonly index: number },
    candidate: boolean,
  ): void => {
    if (!isLikelyEntry(value)) {
      if (rejected && file && candidate && isEntryCandidate(value, at.exportName.split('.')[0] !== 'default')) {
        const id = (value as { id?: unknown }).id;
        rejected.push({
          file,
          index: at.index,
          exportName: at.exportName,
          ...(typeof id === 'string' ? { entryId: id } : {}),
          reasons: knowledgeEntryRejectionReasons(value),
          cause: RejectionCause.Invalid,
        });
      }
      return;
    }
    const first = firstById.get(value.id);
    if (first) {
      if (first.value !== value) {
        warnings.push(
          `duplicate id "${value.id}" in ${file ?? 'module'} (export "${key}") shadowed by an earlier export "${first.key}" — only the first is registered`,
        );
        if (rejected && file) {
          rejected.push({
            file,
            index: at.index,
            exportName: at.exportName,
            entryId: value.id,
            reasons: [`id: "${value.id}" is already declared by export "${first.key}" — only the first is registered`],
            cause: RejectionCause.DuplicateId,
          });
        }
      }
      return;
    }
    firstById.set(value.id, { value, key });
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
      tryPush(value, key, { exportName: key, index: -1 }, key === 'default');
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, i: number) => tryPush(item, `${key}[${i}]`, { exportName: key, index: i }, true));
    } else if (value && typeof value === 'object' && 'entries' in (value as object)) {
      const inner = (value as { entries?: unknown }).entries;
      if (Array.isArray(inner)) {
        inner.forEach((item: unknown, i: number) =>
          tryPush(item, `${key}.entries[${i}]`, { exportName: `${key}.entries`, index: i }, true),
        );
      }
    } else if (key === 'default') {
      // A single default object meant as an entry is one, or a rejection.
      tryPush(value, key, { exportName: 'default', index: -1 }, true);
    }
  }
}

/**
 * The list fields every consumer reads as arrays (`entry.appliesWhen.length`).
 * `defineKnowledgeEntry` defaults them to `[]`; a raw literal may omit them,
 * and used to load, validate — and then crash `shrk knowledge get`.
 */
const LIST_FIELDS = ['tags', 'scope', 'appliesWhen'] as const;

/** Missing list fields become a frozen `[]`; a non-list value is replaced by one, with a warning. */
function normalizeListFields(entry: IKnowledgeEntry, file: string, warnings: string[]): void {
  const rec = entry as unknown as Record<string, unknown>;
  for (const field of LIST_FIELDS) {
    const value = rec[field];
    if (Array.isArray(value)) continue;
    if (value !== undefined && value !== null) {
      warnings.push(
        `${file}: entry "${entry.id}" has a non-list \`${field}\` (${typeof value}) — treated as [] (write a string array)`,
      );
    }
    try {
      rec[field] = Object.freeze([]);
    } catch {
      // A frozen literal cannot be patched in place; the formatters guard.
      warnings.push(`${file}: entry "${entry.id}" is frozen without a \`${field}\` list — read as []`);
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
    const rejected: IRejectedEntry[] = [];

    if (!existsSync(filePath)) {
      warnings.push(`Knowledge file not found: ${filePath}`);
      return { entries, warnings, sourceFiles, rejected };
    }
    sourceFiles.push(filePath);

    const result = this._importContext
      ? await this._importContext.load(filePath)
      : await safeImport(filePath, { skipExistsCheck: true });

    if (!result.ok) {
      const label = result.timedOut ? 'timed out importing' : 'Failed to import';
      warnings.push(`${label} ${filePath}: ${result.error.message}`);
      return { entries, warnings, sourceFiles, rejected };
    }

    collectEntriesFromModule(result.module, entries, warnings, filePath, rejected);
    for (const entry of entries) {
      normalizeListFields(entry, filePath, warnings);
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

    return { entries, warnings, sourceFiles, rejected };
  }
}
