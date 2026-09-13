import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

const PROJECT_ROOT_MARKERS = [
  'package.json',
  'bun.lockb',
  'pnpm-workspace.yaml',
  'nx.json',
  'tsconfig.base.json',
  '.git',
];

export interface ProjectRootInfo {
  root: string;
  markers: string[];
}

export function detectProjectRoot(startDir: string): ProjectRootInfo {
  let current = nodePath.resolve(startDir);
  const seen: string[] = [];
  while (true) {
    const found = PROJECT_ROOT_MARKERS.filter((m) => existsSync(nodePath.join(current, m)));
    if (found.length > 0) return { root: current, markers: found };
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return { root: nodePath.resolve(startDir), markers: seen };
    }
    current = parent;
  }
}

export function findSharkcraftDir(projectRoot: string, configuredDir = 'sharkcraft'): string | null {
  const candidate = nodePath.join(projectRoot, configuredDir);
  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The nearest ANCESTOR of `projectRoot` that holds a `<dirName>/` folder,
 * searched up to the repository top (the first directory carrying `.git`) or
 * the filesystem root. `null` when there is none, or when `projectRoot` is
 * itself the repository top.
 *
 * Discovery binds to the NEAREST root marker, so a command run inside a nested
 * workspace member (its own package.json, no sharkcraft/ folder) resolves that
 * member as the root and loads nothing. Walking up BY DEFAULT would silently
 * rebind every such member — this repo alone has over a dozen example packages
 * with their own package.json — to the parent's config, so this is a HINT for
 * a loud refusal ("rerun with --cwd <ancestor>"), never a rebinding.
 */
export function findConfiguredAncestor(projectRoot: string, dirName = 'sharkcraft'): string | null {
  let current = nodePath.resolve(projectRoot);
  if (existsSync(nodePath.join(current, '.git'))) return null;
  while (true) {
    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
    if (findSharkcraftDir(current, dirName)) return current;
    if (existsSync(nodePath.join(current, '.git'))) return null;
  }
}
