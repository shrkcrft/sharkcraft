import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

export interface IWorkspacePackage {
  /** package.json name field. */
  name: string;
  /** Project-relative directory (POSIX separators). */
  dir: string;
  /** Entry point (project-relative) — best-effort. */
  entry?: string;
}

/**
 * Discover workspace packages from `package.json`'s `workspaces` field.
 * Supports both the array and the `{ packages: [...] }` form.
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
  for (const pattern of patterns) {
    const dir = pattern.replace(/\/\*?$/, '');
    const full = nodePath.join(projectRoot, dir);
    if (!existsSync(full)) continue;
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const child of entries) {
      const inner = nodePath.join(full, child);
      try {
        if (!statSync(inner).isDirectory()) continue;
      } catch {
        continue;
      }
      const childPkg = nodePath.join(inner, 'package.json');
      if (!existsSync(childPkg)) continue;
      try {
        const pj = JSON.parse(readFileSync(childPkg, 'utf8')) as {
          name?: string;
          main?: string;
          module?: string;
          types?: string;
        };
        if (!pj.name) continue;
        const relDir = nodePath.relative(projectRoot, inner).split(nodePath.sep).join('/');
        const entry = pj.main ?? pj.module ?? pj.types;
        out.push({
          name: pj.name,
          dir: relDir,
          ...(entry ? { entry: `${relDir}/${entry.replace(/^\.\//, '')}` } : {}),
        });
      } catch {
        /* ignore */
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
