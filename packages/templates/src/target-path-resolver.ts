import type { ITemplateDefinition } from './template-definition.ts';
import type { TemplateVariableValues } from './template-variable.ts';
import { isAbsolutePath, isPathInside, joinPath, normalizePath } from '@shrkcrft/core';

export interface IResolvedTargetPath {
  rawPath: string;
  absolutePath: string;
  isInsideProject: boolean;
}

export function resolveTargetPath(
  template: ITemplateDefinition,
  values: TemplateVariableValues,
  projectRoot: string,
): IResolvedTargetPath | null {
  if (!template.targetPath) return null;
  const raw = typeof template.targetPath === 'function' ? template.targetPath(values) : template.targetPath;
  if (!raw) return null;
  const normalized = normalizePath(raw);
  const absolutePath = isAbsolutePath(normalized) ? normalized : joinPath(projectRoot, normalized);
  return {
    rawPath: raw,
    absolutePath,
    isInsideProject: isPathInside(absolutePath, projectRoot) || absolutePath === projectRoot,
  };
}
