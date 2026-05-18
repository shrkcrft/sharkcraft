import { isAbsolutePath, isPathInside, joinPath, normalizePath } from '@shrkcrft/core';
export function resolveTargetPath(template, values, projectRoot) {
    if (!template.targetPath)
        return null;
    const raw = typeof template.targetPath === 'function' ? template.targetPath(values) : template.targetPath;
    if (!raw)
        return null;
    const normalized = normalizePath(raw);
    const absolutePath = isAbsolutePath(normalized) ? normalized : joinPath(projectRoot, normalized);
    return {
        rawPath: raw,
        absolutePath,
        isInsideProject: isPathInside(absolutePath, projectRoot) || absolutePath === projectRoot,
    };
}
