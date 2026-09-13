import { existsSync } from 'node:fs';
import { type IImportContext, type IRejectedEntry, RejectionCause, safeImport } from '@shrkcrft/core';
import type { ITemplateDefinition } from './template-definition.ts';

/**
 * THE template-shape predicate the loader registers by. Exported so the
 * unregistered-export check asks exactly the question the loader asks.
 */
export function isTemplate(value: unknown): value is ITemplateDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string';
}

/**
 * Why `value` is not a template: one `<field>: <message>` per field
 * {@link isTemplate} requires and `value` lacks — `[]` when it is one.
 */
export function templateRejectionReasons(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['(entry): must be an object'];
  const v = value as Record<string, unknown>;
  const out: string[] = [];
  if (typeof v.id !== 'string') out.push('id: must be a string');
  if (typeof v.name !== 'string') out.push('name: must be a string');
  return out;
}

/** An object plainly meant as a template: it carries a string `id`, `name` or `title`. */
function isTemplateCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' || typeof v.name === 'string' || typeof v.title === 'string';
}

/**
 * The list fields every consumer reads as arrays (`t.tags.length` in
 * `templates list`). `ITemplateDefinition` declares them, but THE predicate
 * accepts a template by id + name only — so, exactly as the knowledge loader
 * does for its list fields, a missing one is normalised to a frozen `[]`
 * rather than reaching a consumer as `undefined` (round 12, 12.1d: `templates
 * list` crashed on a pack template with no `tags`).
 */
const TEMPLATE_LIST_FIELDS = ['tags', 'scope', 'appliesWhen', 'variables'] as const;

function normalizeTemplateListFields(t: ITemplateDefinition, file: string, warnings: string[]): void {
  const rec = t as unknown as Record<string, unknown>;
  for (const field of TEMPLATE_LIST_FIELDS) {
    const value = rec[field];
    if (Array.isArray(value)) continue;
    if (value !== undefined && value !== null) {
      warnings.push(`${file}: template "${t.id}" has a non-list \`${field}\` (${typeof value}) — treated as []`);
    }
    try {
      rec[field] = Object.freeze([]);
    } catch {
      warnings.push(`${file}: template "${t.id}" is frozen without a \`${field}\` list — read as []`);
    }
  }
}

export interface ILoadedTemplates {
  templates: ITemplateDefinition[];
  warnings: string[];
  sourceFiles: string[];
  /**
   * Every template the file declared that the loader refused (round 12,
   * 12.1): a list member (or the `default` object) meant as a template that
   * fails {@link isTemplate}, and a different object reusing an id.
   */
  rejected: IRejectedEntry[];
}

export interface ILoadTemplatesOptions {
  importContext?: IImportContext;
}

export async function loadTemplatesFromFile(
  filePath: string,
  options: ILoadTemplatesOptions = {},
): Promise<ILoadedTemplates> {
  const warnings: string[] = [];
  const templates: ITemplateDefinition[] = [];
  const sourceFiles: string[] = [];
  const rejected: IRejectedEntry[] = [];

  if (!existsSync(filePath)) {
    warnings.push(`Template file not found: ${filePath}`);
    return { templates, warnings, sourceFiles, rejected };
  }
  sourceFiles.push(filePath);

  const result = options.importContext
    ? await options.importContext.load(filePath)
    : await safeImport(filePath, { skipExistsCheck: true });

  if (!result.ok) {
    const label = result.timedOut ? 'timed out importing' : 'Failed to import';
    warnings.push(`${label} ${filePath}: ${result.error.message}`);
    return { templates, warnings, sourceFiles, rejected };
  }

  // First OBJECT per id, and the export it came from. The same object exported
  // twice (`export const t` + `export default [t]`) is one template; a
  // DIFFERENT object reusing an id is silently shadowed — so say so.
  const firstById = new Map<string, { value: unknown; key: string }>();
  const tryPush = (
    v: unknown,
    key: string,
    at: { readonly exportName: string; readonly index: number },
    candidate: boolean,
  ): void => {
    if (!isTemplate(v)) {
      if (candidate && isTemplateCandidate(v)) {
        const id = (v as { id?: unknown }).id;
        rejected.push({
          file: filePath,
          index: at.index,
          exportName: at.exportName,
          ...(typeof id === 'string' ? { entryId: id } : {}),
          reasons: templateRejectionReasons(v),
          cause: RejectionCause.Invalid,
        });
      }
      return;
    }
    const first = firstById.get(v.id);
    if (first) {
      if (first.value !== v) {
        warnings.push(
          `duplicate id "${v.id}" in ${filePath} (export "${key}") shadowed by an earlier export "${first.key}" — only the first is registered`,
        );
        rejected.push({
          file: filePath,
          index: at.index,
          exportName: at.exportName,
          entryId: v.id,
          reasons: [`id: "${v.id}" is already declared by export "${first.key}" — only the first is registered`],
          cause: RejectionCause.DuplicateId,
        });
      }
      return;
    }
    firstById.set(v.id, { value: v, key });
    normalizeTemplateListFields(v, filePath, warnings);
    templates.push(v);
  };
  for (const key of Object.keys(result.module)) {
    const v = result.module[key];
    if (isTemplate(v)) {
      tryPush(v, key, { exportName: key, index: -1 }, key === 'default');
    } else if (Array.isArray(v)) {
      // `default[3]`: the index tells two members of one array export apart.
      v.forEach((item: unknown, i: number) => tryPush(item, `${key}[${i}]`, { exportName: key, index: i }, true));
    } else if (key === 'default') {
      tryPush(v, key, { exportName: 'default', index: -1 }, true);
    }
  }
  if (templates.length === 0) warnings.push(`No templates exported by ${filePath}`);

  return { templates, warnings, sourceFiles, rejected };
}
