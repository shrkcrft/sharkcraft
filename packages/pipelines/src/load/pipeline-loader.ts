import { existsSync } from 'node:fs';
import { type IImportContext, type IRejectedEntry, RejectionCause, safeImport } from '@shrkcrft/core';
import type { IPipelineDefinition } from '../model/pipeline-definition.ts';

/** THE pipeline-shape predicate the loader registers by. */
export function isPipeline(value: unknown): value is IPipelineDefinition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.description === 'string' &&
    Array.isArray(v.steps)
  );
}

/**
 * Why `value` is not a pipeline: one `<field>: <message>` per field
 * {@link isPipeline} requires and `value` lacks — `[]` when it is one.
 */
export function pipelineRejectionReasons(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['(entry): must be an object'];
  const v = value as Record<string, unknown>;
  const out: string[] = [];
  for (const f of ['id', 'title', 'description'] as const) {
    if (typeof v[f] !== 'string') out.push(`${f}: must be a string`);
  }
  if (!Array.isArray(v.steps)) out.push('steps: must be an array');
  return out;
}

/** An object plainly meant as a pipeline: it carries a string `id` or `title`. */
function isPipelineCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' || typeof v.title === 'string';
}

export interface ILoadedPipelines {
  pipelines: IPipelineDefinition[];
  warnings: string[];
  sourceFiles: string[];
  /**
   * Every pipeline the file declared that the loader refused (round 12,
   * 12.1): a list member (or the `default` object) meant as a pipeline that
   * fails {@link isPipeline}, and a different object reusing an id — both were
   * dropped with no signal before.
   */
  rejected: IRejectedEntry[];
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
  const rejected: IRejectedEntry[] = [];

  if (!existsSync(filePath)) {
    warnings.push(`Pipeline file not found: ${filePath}`);
    return { pipelines, warnings, sourceFiles, rejected };
  }
  sourceFiles.push(filePath);

  const result = options.importContext
    ? await options.importContext.load(filePath)
    : await safeImport(filePath, { skipExistsCheck: true });

  if (!result.ok) {
    const label = result.timedOut ? 'timed out importing' : 'Failed to import';
    warnings.push(`${label} ${filePath}: ${result.error.message}`);
    return { pipelines, warnings, sourceFiles, rejected };
  }

  // First OBJECT per id. The same object exported twice is one pipeline; a
  // DIFFERENT object reusing an id used to be dropped silently.
  const firstById = new Map<string, { value: unknown; key: string }>();
  const tryPush = (
    v: unknown,
    key: string,
    at: { readonly exportName: string; readonly index: number },
    candidate: boolean,
  ): void => {
    if (!isPipeline(v)) {
      if (candidate && isPipelineCandidate(v)) {
        const id = (v as { id?: unknown }).id;
        rejected.push({
          file: filePath,
          index: at.index,
          exportName: at.exportName,
          ...(typeof id === 'string' ? { entryId: id } : {}),
          reasons: pipelineRejectionReasons(v),
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
    const p: IPipelineDefinition = { ...v, source: v.source ?? { origin: filePath } };
    pipelines.push(p);
  };
  for (const key of Object.keys(result.module)) {
    const v = result.module[key];
    if (isPipeline(v)) {
      tryPush(v, key, { exportName: key, index: -1 }, key === 'default');
    } else if (Array.isArray(v)) {
      v.forEach((item: unknown, i: number) => tryPush(item, `${key}[${i}]`, { exportName: key, index: i }, true));
    } else if (key === 'default') {
      tryPush(v, key, { exportName: 'default', index: -1 }, true);
    }
  }
  if (pipelines.length === 0) warnings.push(`No pipelines exported by ${filePath}`);

  return { pipelines, warnings, sourceFiles, rejected };
}
