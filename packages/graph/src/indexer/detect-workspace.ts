import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs';
import * as nodePath from 'node:path';

export interface IWorkspacePackage {
  /** package.json name field. */
  name: string;
  /** Project-relative directory (POSIX separators). */
  dir: string;
  /** Entry point (project-relative) — best-effort. */
  entry?: string;
}

/** Directories never traversed while discovering workspace packages. */
const PRUNED_DIRS = new Set(['node_modules', '.git', 'dist']);

/**
 * Upper bound on how deep a `*`/`**` glob descends below its literal prefix.
 * A package is treated as a leaf (descent stops once a `package.json` is
 * found), so this only guards pathological trees with no package roots.
 */
const MAX_GLOB_DEPTH = 6;

/**
 * Discover workspace packages from `package.json`'s `workspaces` field.
 * Supports both the array and the `{ packages: [...] }` form.
 *
 * A glob whose segment is `*` (or `**`) is matched by recursing below the
 * literal prefix until a `package.json` is found, so nested layouts like
 * `packages/<group>/<pkg>/package.json` are discovered as well as flat
 * `packages/<pkg>/package.json` ones. Each package directory is a leaf —
 * descent stops there — and `node_modules`/`.git`/`dist` plus symlinks are
 * pruned so the walk stays bounded.
 *
 * Nx integration is deliberately out of scope here — Nx's project graph
 * is a separate optional input considered later (see code-intelligence.md
 * §8.3).
 */
export function detectWorkspacePackages(projectRoot: string): readonly IWorkspacePackage[] {
  const pkgPath = nodePath.join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return [];
  }
  const wsRaw = (raw as { workspaces?: unknown }).workspaces;
  const patterns = normalizeWorkspaces(wsRaw);
  const out: IWorkspacePackage[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const segments = pattern.split('/').filter((s) => s.length > 0);
    const firstGlob = segments.findIndex((s) => s === '*' || s === '**');
    if (firstGlob === -1) {
      // No glob segment: keep the original one-level behavior — read the
      // immediate children of the named directory and pick those carrying a
      // `package.json` (flat layouts that name the container directly).
      const baseDir = nodePath.join(projectRoot, ...segments);
      collectChildPackages(projectRoot, baseDir, out, seen);
      continue;
    }
    // Glob present: anchor on the literal prefix and recurse downward to
    // every `package.json` at or below the glob's position.
    const baseDir = nodePath.join(projectRoot, ...segments.slice(0, firstGlob));
    collectPackagesUnder(projectRoot, baseDir, 0, out, seen);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A traversable directory entry: a real subdir, not a symlink or pruned name. */
function isTraversableDir(ent: Dirent): boolean {
  if (ent.isSymbolicLink()) return false;
  if (!ent.isDirectory()) return false;
  return !PRUNED_DIRS.has(ent.name);
}

/** Read child directories of `baseDir` and record those holding a package.json. */
function collectChildPackages(
  projectRoot: string,
  baseDir: string,
  out: IWorkspacePackage[],
  seen: Set<string>,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!isTraversableDir(ent)) continue;
    const childAbs = nodePath.join(baseDir, ent.name);
    const childPkg = nodePath.join(childAbs, 'package.json');
    if (!existsSync(childPkg)) continue;
    pushPackage(projectRoot, childAbs, childPkg, out, seen);
  }
}

/**
 * Recurse below `baseDir`, recording every directory that carries a
 * `package.json`. A package directory is a leaf — recursion does not descend
 * into it — so nested-but-bounded layouts resolve without scanning the whole
 * tree. Depth is capped by {@link MAX_GLOB_DEPTH}.
 */
function collectPackagesUnder(
  projectRoot: string,
  baseDir: string,
  depth: number,
  out: IWorkspacePackage[],
  seen: Set<string>,
): void {
  if (depth >= MAX_GLOB_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!isTraversableDir(ent)) continue;
    const childAbs = nodePath.join(baseDir, ent.name);
    const childPkg = nodePath.join(childAbs, 'package.json');
    if (existsSync(childPkg)) {
      // Package leaf: record it and stop — don't treat sub-folders (e.g.
      // fixtures with their own package.json) as separate packages.
      pushPackage(projectRoot, childAbs, childPkg, out, seen);
      continue;
    }
    collectPackagesUnder(projectRoot, childAbs, depth + 1, out, seen);
  }
}

/** Parse a package.json and append an IWorkspacePackage entry (deduped by dir). */
function pushPackage(
  projectRoot: string,
  dirAbs: string,
  pkgPath: string,
  out: IWorkspacePackage[],
  seen: Set<string>,
): void {
  let pj: { name?: string; main?: string; module?: string; types?: string };
  try {
    pj = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return;
  }
  if (!pj.name) return;
  const relDir = nodePath.relative(projectRoot, dirAbs).split(nodePath.sep).join('/');
  if (seen.has(relDir)) return;
  seen.add(relDir);
  const entry = pj.main ?? pj.module ?? pj.types;
  out.push({
    name: pj.name,
    dir: relDir,
    ...(entry ? { entry: `${relDir}/${entry.replace(/^\.\//, '')}` } : {}),
  });
}

function normalizeWorkspaces(value: unknown): readonly string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'object') {
    const packages = (value as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((v): v is string => typeof v === 'string');
    }
  }
  return [];
}
