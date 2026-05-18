import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IPackageJson } from './package-json-reader.ts';

/**
 * Coarse project-shape classification. Drives the default
 * surface composition: a single-app repo hides monorepo-only
 * commands by default; a library repo hides app-only commands.
 */
export enum ProjectShape {
  SingleApp = 'single-app',
  AppWithLibs = 'app-with-libs',
  Monorepo = 'monorepo',
  Library = 'library',
  Unknown = 'unknown',
}

export interface IProjectShapeDetection {
  shape: ProjectShape;
  evidence: readonly string[];
  /** Hint signals the resolver collected during detection. */
  signals: {
    hasAngularJson: boolean;
    hasNxJson: boolean;
    nxProjectCount: number | null;
    workspaceCount: number | null;
    hasAppsDir: boolean;
    hasLibsDir: boolean;
    hasDevServeScript: boolean;
    hasOnlyBuildTestScripts: boolean;
  };
}

export interface DetectProjectShapeOptions {
  projectRoot: string;
  /** Pre-loaded package.json, if available. */
  packageJson?: IPackageJson | null;
}

/**
 * Deterministic project-shape detector. No AI, no heuristics
 * beyond file/dependency presence. Result is cacheable.
 *
 * Rules (first match wins; subsequent signals contribute evidence
 * but do not change the verdict):
 *
 *   1. `nx.json` present AND ≥6 Nx projects discovered → Monorepo.
 *   2. `package.json workspaces` field with ≥3 entries → Monorepo.
 *   3. `angular.json` workspace with exactly one project → SingleApp.
 *   4. `apps/` AND `libs/` dirs present (Nx-style) → AppWithLibs.
 *   5. `package.json` with build/test scripts but NO dev/serve/start
 *      script AND no app dir → Library.
 *   6. Otherwise → Unknown.
 */
export function detectProjectShape(
  options: DetectProjectShapeOptions,
): IProjectShapeDetection {
  const { projectRoot, packageJson } = options;
  const evidence: string[] = [];
  const signals = {
    hasAngularJson: existsSync(nodePath.join(projectRoot, 'angular.json')),
    hasNxJson: existsSync(nodePath.join(projectRoot, 'nx.json')),
    nxProjectCount: null as number | null,
    workspaceCount: null as number | null,
    hasAppsDir: existsSync(nodePath.join(projectRoot, 'apps')),
    hasLibsDir: existsSync(nodePath.join(projectRoot, 'libs')),
    hasDevServeScript: false,
    hasOnlyBuildTestScripts: false,
  };

  // Nx project count (best-effort: read nx.json + count projects/).
  if (signals.hasNxJson) {
    signals.nxProjectCount = countNxProjects(projectRoot);
    if (signals.nxProjectCount !== null) {
      evidence.push(`nx.json present (${signals.nxProjectCount} projects)`);
    } else {
      evidence.push('nx.json present');
    }
  }

  // Workspaces count.
  if (packageJson?.workspaces !== undefined) {
    const ws = packageJson.workspaces as string[] | { packages?: string[] };
    const list = Array.isArray(ws) ? ws : (ws.packages ?? []);
    signals.workspaceCount = list.length;
    evidence.push(`package.json workspaces (${list.length} entries)`);
  }

  // Angular detection.
  if (signals.hasAngularJson) {
    evidence.push('angular.json present');
  }

  // Script-based signals.
  const scripts = packageJson?.scripts ?? {};
  const scriptNames = Object.keys(scripts);
  signals.hasDevServeScript = scriptNames.some((s) =>
    ['dev', 'serve', 'start'].includes(s),
  );
  signals.hasOnlyBuildTestScripts =
    scriptNames.length > 0 &&
    scriptNames.every((s) => /^(build|test|lint|format|prepublish|prepare)/.test(s));

  if (signals.hasAppsDir) evidence.push('apps/ directory');
  if (signals.hasLibsDir) evidence.push('libs/ directory');
  if (signals.hasDevServeScript) evidence.push('dev/serve/start script');
  if (signals.hasOnlyBuildTestScripts) evidence.push('only build/test scripts');

  // Count workspaces-glob packages on disk (cheap dir count for
  // `packages/`, `libs/`, `apps/` — a glob like `packages/*` matches
  // any direct subdir).
  const packagesDirCount = countDirectChildren(nodePath.join(projectRoot, 'packages'));
  if (packagesDirCount > 0) {
    evidence.push(`packages/ (${packagesDirCount} entries)`);
  }

  // Apply rules — strongest signals first. Conservative on SingleApp:
  // require an unambiguous app signal (angular.json single project, or
  // a dev script in a project with NO sibling packages and NO nx.json
  // and NO workspaces field).
  if (signals.hasNxJson && (signals.nxProjectCount ?? 0) >= 6) {
    return { shape: ProjectShape.Monorepo, evidence, signals };
  }
  if ((signals.workspaceCount ?? 0) >= 3) {
    return { shape: ProjectShape.Monorepo, evidence, signals };
  }
  if (signals.hasNxJson && packagesDirCount >= 6) {
    return { shape: ProjectShape.Monorepo, evidence, signals };
  }
  if (
    (signals.workspaceCount ?? 0) >= 1 &&
    packagesDirCount >= 3
  ) {
    return { shape: ProjectShape.Monorepo, evidence, signals };
  }
  if (signals.hasAngularJson) {
    const projectCount = countAngularProjects(projectRoot);
    if (projectCount !== null && projectCount > 1) {
      evidence.push(`angular.json (${projectCount} projects)`);
      return { shape: ProjectShape.AppWithLibs, evidence, signals };
    }
    return { shape: ProjectShape.SingleApp, evidence, signals };
  }
  if (signals.hasAppsDir && signals.hasLibsDir) {
    return { shape: ProjectShape.AppWithLibs, evidence, signals };
  }
  if (signals.hasOnlyBuildTestScripts && !signals.hasAppsDir && packagesDirCount === 0) {
    return { shape: ProjectShape.Library, evidence, signals };
  }
  if (
    signals.hasDevServeScript &&
    !signals.hasLibsDir &&
    !signals.hasNxJson &&
    signals.workspaceCount === null &&
    packagesDirCount === 0
  ) {
    return { shape: ProjectShape.SingleApp, evidence, signals };
  }
  return { shape: ProjectShape.Unknown, evidence, signals };
}

function countDirectChildren(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

function countNxProjects(projectRoot: string): number | null {
  // Best-effort: count entries in nx.json `projects` (legacy) or count
  // `project.json` files. Avoid recursing the whole tree; cap depth.
  const nxFile = nodePath.join(projectRoot, 'nx.json');
  try {
    const nx = JSON.parse(readFileSync(nxFile, 'utf8')) as {
      projects?: Record<string, unknown>;
    };
    if (nx.projects && typeof nx.projects === 'object') {
      return Object.keys(nx.projects).length;
    }
  } catch {
    // ignore
  }
  // Fallback: look in apps/ + libs/ for project.json sentinels.
  let count = 0;
  for (const root of ['apps', 'libs', 'packages']) {
    const dir = nodePath.join(projectRoot, root);
    if (!existsSync(dir)) continue;
    try {
      const entries = readJsonChildren(dir);
      count += entries;
    } catch {
      // ignore
    }
  }
  return count > 0 ? count : null;
}

function countAngularProjects(projectRoot: string): number | null {
  try {
    const angularJson = JSON.parse(
      readFileSync(nodePath.join(projectRoot, 'angular.json'), 'utf8'),
    ) as { projects?: Record<string, unknown> };
    if (angularJson.projects && typeof angularJson.projects === 'object') {
      return Object.keys(angularJson.projects).length;
    }
  } catch {
    // ignore
  }
  return null;
}

function readJsonChildren(dir: string): number {
  let count = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const projectJson = nodePath.join(dir, e.name, 'project.json');
      if (existsSync(projectJson)) count += 1;
    }
  }
  return count;
}

/* ---------- Cache ---------- */

export interface IProjectShapeCacheEntry {
  schema: 'sharkcraft.shape.v1';
  detection: IProjectShapeDetection;
  cachedAt: string;
}

const CACHE_DIR = '.sharkcraft';
const CACHE_FILE = 'shape.json';

export function cacheProjectShape(
  projectRoot: string,
  detection: IProjectShapeDetection,
): string {
  const dir = nodePath.join(projectRoot, CACHE_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = nodePath.join(dir, CACHE_FILE);
  const entry: IProjectShapeCacheEntry = {
    schema: 'sharkcraft.shape.v1',
    detection,
    cachedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  return file;
}

export function readCachedProjectShape(
  projectRoot: string,
): IProjectShapeCacheEntry | null {
  const file = nodePath.join(projectRoot, CACHE_DIR, CACHE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IProjectShapeCacheEntry;
  } catch {
    return null;
  }
}
