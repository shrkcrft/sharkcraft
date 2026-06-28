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

/**
 * TS NodeNext / ESM resolution requires import specifiers to carry a JS-family
 * extension even though the file on disk is TypeScript (`import './x.js'` →
 * `x.ts`). Map each JS extension to the TS source extension(s) the compiler
 * would have emitted it from. Without this, every `.js`-suffixed relative import
 * in a NodeNext project is a false "unresolved import" — the single biggest
 * source of under-counted graph dependents.
 */
const JS_TO_TS_EXTS: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx', '.ts'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * The declaration extension. It cannot live in `PROBE_EXTS` because
 * `extname('x.d.ts') === '.ts'` (so the `includes(ext)` literal-path guard would
 * never match it), and it must always be tried LAST — a real implementation file
 * wins over a declaration. But a declaration-only module (a hand-authored
 * `.d.ts` with no sibling impl) is still a resolvable graph target, not an
 * unresolved import, so it is appended as the final candidate everywhere.
 */
const DECL_EXT = '.d.ts';

function probeCandidate(absPathNoExt: string): string | undefined {
  // If the path already has a known extension and exists, return it.
  const ext = nodePath.extname(absPathNoExt);
  if (PROBE_EXTS.includes(ext)) {
    // A real file on disk at the literal path wins (a genuine `.js` next to no
    // `.ts`, an asset, etc.).
    if (existsSafe(absPathNoExt) && isFile(absPathNoExt)) {
      return absPathNoExt;
    }
    // NodeNext: rewrite the JS-family extension to its TS source extension and
    // probe those (then a declaration-only sibling) before giving up.
    const tsExts = JS_TO_TS_EXTS[ext];
    if (tsExts) {
      const base = absPathNoExt.slice(0, -ext.length);
      for (const e of tsExts) {
        const cand = base + e;
        if (existsSafe(cand) && isFile(cand)) return cand;
      }
      const dts = base + DECL_EXT;
      if (existsSafe(dts) && isFile(dts)) return dts;
    }
  }
  // Try appending each known extension (extensionless specifier), then `.d.ts`.
  for (const e of [...PROBE_EXTS, DECL_EXT]) {
    const cand = absPathNoExt + e;
    if (existsSafe(cand) && isFile(cand)) return cand;
  }
  // Try as a directory with index.<ext> (then index.d.ts).
  if (existsSafe(absPathNoExt) && isDir(absPathNoExt)) {
    for (const e of [...PROBE_EXTS, DECL_EXT]) {
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
