import { existsSync } from 'node:fs';
import { type IImportContext, safeImport } from '@shrkcrft/core';
import type { IPipelineDefinition } from '../model/pipeline-definition.ts';

function isPipeline(value: unknown): value is IPipelineDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.description === 'string' &&
    Array.isArray(v.steps)
  );
}

export interface ILoadedPipelines {
  pipelines: IPipelineDefinition[];
  warnings: string[];
  sourceFiles: string[];
}

export interface ILoadPipelinesOptions {
  importContext?: IImportContext;
}

export async function loadPipelinesFromFile(
  filePath: string,
  options: ILoadPipelinesOptions = {},
): Promise<ILoadedPipelines> {
  const warnings: string[] = [];
  const pipelines: IPipelineDefinition[] = [];
  const sourceFiles: string[] = [];

  if (!existsSync(filePath)) {
    warnings.push(`Pipeline file not found: ${filePath}`);
    return { pipelines, warnings, sourceFiles };
  }
  sourceFiles.push(filePath);

  const result = options.importContext
    ? await options.importContext.load(filePath)
    : await safeImport(filePath, { skipExistsCheck: true });

  if (!result.ok) {
    const label = result.timedOut ? 'timed out importing' : 'Failed to import';
    warnings.push(`${label} ${filePath}: ${result.error.message}`);
    return { pipelines, warnings, sourceFiles };
  }

  const seen = new Set<string>();
  const tryPush = (v: unknown): void => {
    if (!isPipeline(v)) return;
    if (seen.has(v.id)) return;
    seen.add(v.id);
    const p: IPipelineDefinition = { ...v, source: v.source ?? { origin: filePath } };
    pipelines.push(p);
  };
  for (const key of Object.keys(result.module)) {
    const v = result.module[key];
    if (isPipeline(v)) {
      tryPush(v);
    } else if (Array.isArray(v)) {
      for (const item of v) tryPush(item);
    }
  }
  if (pipelines.length === 0) warnings.push(`No pipelines exported by ${filePath}`);

  return { pipelines, warnings, sourceFiles };
}
