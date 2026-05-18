/**
 * Minimal Nx project graph reader.
 *
 * Pure filesystem. NO shell-out to `nx` CLI. NO network. Returns
 * null when `nx.json` is absent; otherwise walks for `project.json`
 * files under common Nx layouts (`apps/`, `libs/`, `packages/`) and
 * returns a `{ name, root, tags }` record.
 *
 * Designed for `shrk plan check` cross-project warnings: given a
 * declared file path, look up which project owns it (by `root`
 * prefix match) and flag plans that touch multiple projects.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

export interface INxProject {
  readonly name: string;
  readonly root: string;
  readonly tags: readonly string[];
}

export interface INxProjectGraph {
  readonly projects: readonly INxProject[];
}

const DEFAULT_SEARCH_ROOTS = ['apps', 'libs', 'packages'];
const MAX_DEPTH = 6;

export function loadNxProjects(projectRoot: string): INxProjectGraph | null {
  if (!existsSync(nodePath.join(projectRoot, 'nx.json'))) return null;
  const projects: INxProject[] = [];
  for (const seed of DEFAULT_SEARCH_ROOTS) {
    const seedAbs = nodePath.join(projectRoot, seed);
    if (!existsSync(seedAbs)) continue;
    walk(seedAbs, projectRoot, 0, projects);
  }
  // Also check the projectRoot itself (single-project workspaces sometimes).
  const rootProject = readProjectJson(projectRoot, projectRoot);
  if (rootProject !== null) projects.push(rootProject);
  return { projects };
}

function walk(dir: string, projectRoot: string, depth: number, out: INxProject[]): void {
  if (depth > MAX_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  // If this directory has a project.json, read it and stop recursing into it.
  const projectJsonPath = nodePath.join(dir, 'project.json');
  if (existsSync(projectJsonPath)) {
    const project = readProjectJson(dir, projectRoot);
    if (project) out.push(project);
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const abs = nodePath.join(dir, entry);
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(abs, projectRoot, depth + 1, out);
  }
}

function readProjectJson(dir: string, projectRoot: string): INxProject | null {
  const p = nodePath.join(dir, 'project.json');
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as { name?: string; tags?: readonly string[] };
    const name = typeof parsed.name === 'string' && parsed.name.length > 0
      ? parsed.name
      : nodePath.basename(dir);
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === 'string') : [];
    const root = nodePath.relative(projectRoot, dir) || '.';
    return { name, root, tags };
  } catch {
    return null;
  }
}

/**
 * Given a list of declared file paths (relative to projectRoot) and
 * an Nx project graph, return the set of unique project NAMES the
 * files belong to. Files that don't map to any known project are
 * silently ignored.
 */
export function mapFilesToProjects(
  files: readonly string[],
  graph: INxProjectGraph,
): readonly string[] {
  // Sort projects by descending root path length so the longest match wins.
  const sorted = [...graph.projects].sort((a, b) => b.root.length - a.root.length);
  const hits = new Set<string>();
  for (const file of files) {
    const normalized = file.replace(/^\.\//, '');
    for (const p of sorted) {
      if (p.root === '.' || p.root === '') continue;
      const prefix = p.root.endsWith('/') ? p.root : `${p.root}/`;
      if (normalized === p.root || normalized.startsWith(prefix)) {
        hits.add(p.name);
        break;
      }
    }
  }
  return [...hits];
}
