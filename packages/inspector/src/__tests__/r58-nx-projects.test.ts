/**
 * Nx project graph reader tests.
 *
 * Pure fs. Verifies that `loadNxProjects` walks for `project.json`
 * files only when `nx.json` is present, and that `mapFilesToProjects`
 * maps file paths to project names by longest-prefix match.
 */
import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { loadNxProjects, mapFilesToProjects } from '../grounding/nx-projects.ts';

let root: string;

beforeEach(() => {
  root = nodePath.join(
    '/tmp',
    `r58-nx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function writeNx(): void {
  writeFileSync(nodePath.join(root, 'nx.json'), '{}\n', 'utf8');
}

function writeProject(rel: string, name: string, tags: string[] = []): void {
  const dir = nodePath.join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nodePath.join(dir, 'project.json'),
    JSON.stringify({ name, tags }, null, 2),
    'utf8',
  );
}

describe('loadNxProjects', () => {
  test('returns null when nx.json is absent', () => {
    expect(loadNxProjects(root)).toBeNull();
  });

  test('walks apps/ libs/ packages/ for project.json files', () => {
    writeNx();
    writeProject('apps/api', 'acme-api', ['scope:api']);
    writeProject('apps/web', 'acme-web', ['scope:angular']);
    writeProject('libs/billing', 'acme-billing', ['scope:domain']);
    const graph = loadNxProjects(root);
    expect(graph).not.toBeNull();
    if (!graph) return;
    const names = graph.projects.map((p) => p.name).sort();
    expect(names).toEqual(['acme-api', 'acme-billing', 'acme-web']);
    const apiProject = graph.projects.find((p) => p.name === 'acme-api');
    expect(apiProject?.tags).toEqual(['scope:api']);
    expect(apiProject?.root).toBe('apps/api');
  });

  test('handles a malformed project.json gracefully', () => {
    writeNx();
    mkdirSync(nodePath.join(root, 'apps/broken'), { recursive: true });
    writeFileSync(nodePath.join(root, 'apps/broken/project.json'), '{ not json', 'utf8');
    const graph = loadNxProjects(root);
    expect(graph).not.toBeNull();
    if (!graph) return;
    // Skipped silently.
    expect(graph.projects).toEqual([]);
  });
});

describe('mapFilesToProjects', () => {
  test('maps files to projects by longest-prefix match', () => {
    const graph = {
      projects: [
        { name: 'acme-api', root: 'apps/api', tags: [] },
        { name: 'acme-billing', root: 'libs/billing', tags: [] },
        { name: 'acme-web', root: 'apps/web', tags: [] },
      ],
    };
    const projects = mapFilesToProjects(
      [
        'apps/api/src/billing.controller.ts',
        'libs/billing/src/billing.service.ts',
        'apps/web/src/main.ts',
      ],
      graph,
    );
    expect([...projects].sort()).toEqual(['acme-api', 'acme-billing', 'acme-web']);
  });

  test('ignores files outside any known project', () => {
    const graph = { projects: [{ name: 'a', root: 'apps/a', tags: [] }] };
    expect(mapFilesToProjects(['unrelated/file.ts'], graph)).toEqual([]);
  });

  test('deduplicates project hits', () => {
    const graph = { projects: [{ name: 'a', root: 'apps/a', tags: [] }] };
    const projects = mapFilesToProjects(['apps/a/x.ts', 'apps/a/y.ts'], graph);
    expect(projects).toEqual(['a']);
  });
});
