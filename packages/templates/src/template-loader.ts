import { existsSync } from 'node:fs';
import { type IImportContext, safeImport } from '@shrkcrft/core';
import type { ITemplateDefinition } from './template-definition.ts';

function isTemplate(value: unknown): value is ITemplateDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string';
}

export interface ILoadedTemplates {
  templates: ITemplateDefinition[];
  warnings: string[];
  sourceFiles: string[];
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

  if (!existsSync(filePath)) {
    warnings.push(`Template file not found: ${filePath}`);
    return { templates, warnings, sourceFiles };
  }
  sourceFiles.push(filePath);

  const result = options.importContext
    ? await options.importContext.load(filePath)
    : await safeImport(filePath, { skipExistsCheck: true });

  if (!result.ok) {
    const label = result.timedOut ? 'timed out importing' : 'Failed to import';
    warnings.push(`${label} ${filePath}: ${result.error.message}`);
    return { templates, warnings, sourceFiles };
  }

  const seen = new Set<string>();
  const tryPush = (v: unknown): void => {
    if (!isTemplate(v)) return;
    if (seen.has(v.id)) return;
    seen.add(v.id);
    templates.push(v);
  };
  for (const key of Object.keys(result.module)) {
    const v = result.module[key];
    if (isTemplate(v)) {
      tryPush(v);
    } else if (Array.isArray(v)) {
      for (const item of v) tryPush(item);
    }
  }
  if (templates.length === 0) warnings.push(`No templates exported by ${filePath}`);

  return { templates, warnings, sourceFiles };
}
