import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  loadTsconfigPaths,
  resolveAliasCandidates,
  type ITsconfigPathsMap,
} from '@shrkcrft/boundaries';
import type { IWorkspacePackage } from './detect-workspace.ts';

const PROBE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/**
 * Extensions for non-code assets a TS/JS file can legitimately import
 * (CSS modules, JSON, images, fonts, wasm). The graph only indexes source
 * files, so these never resolve to a file node — but an asset that EXISTS
 * on disk is NOT an unresolved import (the bundler handles it), whereas a
 * missing one still is a real broken reference.
 */
const NON_CODE_ASSET_EXTS = new Set([
  '.css', '.scss', '.sass', '.less', '.styl',
  '.json', '.json5',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.wasm',
]);

export enum ImportResolution {
  Relative = 'relative',
  Alias = 'alias',
  Workspace = 'workspace',
  External = 'external',
  Asset = 'asset',
  Unresolved = 'unresolved',
}

export interface IResolvedImport {
  /** Project-relative path to the target file, POSIX, when resolved. */
  targetPath?: string;
  kind: ImportResolution;
  /** Specifier as it appeared in source. */
  specifier: string;
}

export interface IImportResolverContext {
  projectRoot: string;
  workspacePackages: readonly IWorkspacePackage[];
  tsconfigPaths: ITsconfigPathsMap;
}

export function createImportResolverContext(
  projectRoot: string,
  workspacePackages: readonly IWorkspacePackage[],
): IImportResolverContext {
  return {
    projectRoot,
    workspacePackages,
    tsconfigPaths: loadTsconfigPaths(projectRoot),
  };
}

/**
 * Resolve an import specifier to a project-relative file path.
 *
 * Resolution order (cheapest first):
 *   1. Relative (`./` or `../`) against the source file's directory.
 *   2. tsconfig path aliases.
 *   3. Workspace package name (exact match or `<pkg>/<sub>`).
 *   4. External — left unresolved with `ImportResolution.External`.
 *
 * `fromAbsPath` is the absolute path of the importing file; needed for
 * relative resolution.
 */
export function resolveImport(
  specifier: string,
  fromAbsPath: string,
  ctx: IImportResolverContext,
): IResolvedImport {
  if (specifier.startsWith('.')) {
    const dir = nodePath.dirname(fromAbsPath);
    const abs = nodePath.resolve(dir, specifier);
    const ext = nodePath.extname(specifier).toLowerCase();
    if (NON_CODE_ASSET_EXTS.has(ext)) {
      // Existing asset → resolved-enough (not counted as unresolved); a
      // missing asset stays Unresolved so a real broken reference is caught.
      if (existsSafe(abs) && isFile(abs)) {
        return { specifier, kind: ImportResolution.Asset };
      }
      return { specifier, kind: ImportResolution.Unresolved };
    }
    const probe = probeCandidate(abs);
    if (probe) {
      return {
        specifier,
        targetPath: toProjectRel(ctx.projectRoot, probe),
        kind: ImportResolution.Relative,
      };
    }
    return { specifier, kind: ImportResolution.Unresolved };
  }

  const aliasCandidates = resolveAliasCandidates(specifier, ctx.tsconfigPaths);
  for (const cand of aliasCandidates) {
    const abs = nodePath.resolve(ctx.projectRoot, cand);
    const probe = probeCandidate(abs);
    if (probe) {
      return {
        specifier,
        targetPath: toProjectRel(ctx.projectRoot, probe),
        kind: ImportResolution.Alias,
      };
    }
  }

  const ws = findWorkspacePackage(specifier, ctx.workspacePackages);
  if (ws) {
    const probe = resolveWorkspaceTarget(specifier, ws, ctx.projectRoot);
    if (probe) {
      return {
        specifier,
        targetPath: toProjectRel(ctx.projectRoot, probe),
        kind: ImportResolution.Workspace,
      };
    }
  }

  return { specifier, kind: ImportResolution.External };
}

function probeCandidate(absPathNoExt: string): string | undefined {
  // If the path already has a known extension and exists, return it.
  const ext = nodePath.extname(absPathNoExt);
  if (PROBE_EXTS.includes(ext) && existsSafe(absPathNoExt) && isFile(absPathNoExt)) {
    return absPathNoExt;
  }
  // Try appending each known extension.
  for (const e of PROBE_EXTS) {
    const cand = absPathNoExt + e;
    if (existsSafe(cand) && isFile(cand)) return cand;
  }
  // Try as a directory with index.<ext>.
  if (existsSafe(absPathNoExt) && isDir(absPathNoExt)) {
    for (const e of PROBE_EXTS) {
      const cand = nodePath.join(absPathNoExt, `index${e}`);
      if (existsSafe(cand) && isFile(cand)) return cand;
    }
  }
  return undefined;
}

function findWorkspacePackage(
  specifier: string,
  packages: readonly IWorkspacePackage[],
): IWorkspacePackage | undefined {
  for (const p of packages) {
    if (specifier === p.name) return p;
    if (specifier.startsWith(p.name + '/')) return p;
  }
  return undefined;
}

function resolveWorkspaceTarget(
  specifier: string,
  pkg: IWorkspacePackage,
  projectRoot: string,
): string | undefined {
  // Exact match → resolve via package entry, falling back to src/index.<ext>.
  if (specifier === pkg.name) {
    if (pkg.entry) {
      const cand = nodePath.resolve(projectRoot, pkg.entry);
      if (existsSafe(cand) && isFile(cand)) return cand;
      // Some packages list ./dist/index.js as main; for source-time graphs
      // we'd rather hit the src/. Try that next.
    }
    const srcIndex = nodePath.resolve(projectRoot, pkg.dir, 'src');
    return probeCandidate(srcIndex);
  }
  // Subpath: `<pkg>/foo/bar`.
  const sub = specifier.slice(pkg.name.length + 1);
  return probeCandidate(nodePath.resolve(projectRoot, pkg.dir, sub));
}

function existsSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function toProjectRel(projectRoot: string, abs: string): string {
  return nodePath.relative(projectRoot, abs).split(nodePath.sep).join('/');
}
