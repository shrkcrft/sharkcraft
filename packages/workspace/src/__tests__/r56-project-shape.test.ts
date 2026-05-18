/**
 * project shape detector. Locks in the verdicts the resolver
 * uses to seed surface.hidden[] by default. The detector is
 * deterministic; the tests build fake project trees in tmp and
 * assert the verdict.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// Pure ESM imports — keeps 'no require(node:*)' happy.
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { detectProjectShape, ProjectShape } from '../project-shape.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r56-shape-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePkg(dir: string, body: Record<string, unknown>): void {
  writeFileSync(nodePath.join(dir, 'package.json'), JSON.stringify(body, null, 2));
}

describe('project shape detector', () => {
  test('Angular single-app workspace → SingleApp', () => {
    withTmp((dir) => {
      writePkg(dir, { name: 'demo', scripts: { dev: 'ng serve' } });
      writeFileSync(
        nodePath.join(dir, 'angular.json'),
        JSON.stringify({ projects: { app: {} } }),
      );
      const d = detectProjectShape({ projectRoot: dir, packageJson: { name: 'demo', scripts: { dev: 'ng serve' } } });
      expect(d.shape).toBe(ProjectShape.SingleApp);
      expect(d.evidence.some((e) => e.includes('angular.json'))).toBe(true);
    });
  });

  test('Angular multi-project workspace → AppWithLibs', () => {
    withTmp((dir) => {
      writePkg(dir, { name: 'demo' });
      writeFileSync(
        nodePath.join(dir, 'angular.json'),
        JSON.stringify({ projects: { app: {}, libA: {}, libB: {} } }),
      );
      const d = detectProjectShape({ projectRoot: dir, packageJson: { name: 'demo' } });
      expect(d.shape).toBe(ProjectShape.AppWithLibs);
    });
  });

  test('Nx workspace with >5 inferred packages → Monorepo', () => {
    withTmp((dir) => {
      writePkg(dir, { name: 'demo' });
      writeFileSync(nodePath.join(dir, 'nx.json'), JSON.stringify({}));
      const packages = nodePath.join(dir, 'packages');
      mkdirSync(packages);
      for (let i = 0; i < 6; i += 1) mkdirSync(nodePath.join(packages, `p${i}`));
      const d = detectProjectShape({ projectRoot: dir, packageJson: { name: 'demo' } });
      expect(d.shape).toBe(ProjectShape.Monorepo);
    });
  });

  test('package.json workspaces >=3 → Monorepo', () => {
    withTmp((dir) => {
      writePkg(dir, { name: 'demo', workspaces: ['a/*', 'b/*', 'c/*'] });
      const d = detectProjectShape({
        projectRoot: dir,
        packageJson: { name: 'demo', workspaces: ['a/*', 'b/*', 'c/*'] },
      });
      expect(d.shape).toBe(ProjectShape.Monorepo);
    });
  });

  test('library: only build/test scripts, no apps dir → Library', () => {
    withTmp((dir) => {
      writePkg(dir, { name: 'lib', scripts: { build: 'tsc', test: 'bun test' } });
      const d = detectProjectShape({
        projectRoot: dir,
        packageJson: { name: 'lib', scripts: { build: 'tsc', test: 'bun test' } },
      });
      expect(d.shape).toBe(ProjectShape.Library);
    });
  });

  test('app-with-libs: apps/ + libs/ present', () => {
    withTmp((dir) => {
      writePkg(dir, { name: 'demo' });
      mkdirSync(nodePath.join(dir, 'apps'));
      mkdirSync(nodePath.join(dir, 'libs'));
      const d = detectProjectShape({ projectRoot: dir, packageJson: { name: 'demo' } });
      expect(d.shape).toBe(ProjectShape.AppWithLibs);
    });
  });

  test('unknown when no strong signals', () => {
    withTmp((dir) => {
      writePkg(dir, { name: 'demo' });
      const d = detectProjectShape({ projectRoot: dir, packageJson: { name: 'demo' } });
      expect(d.shape).toBe(ProjectShape.Unknown);
    });
  });

  test('SharkCraft-style monorepo (nx.json + 22 packages) → Monorepo', () => {
    withTmp((dir) => {
      writePkg(dir, { name: 'monorepo', workspaces: ['packages/*', 'examples/*'], scripts: { dev: 'shrk', build: 'tsc' } });
      writeFileSync(nodePath.join(dir, 'nx.json'), JSON.stringify({}));
      const packages = nodePath.join(dir, 'packages');
      mkdirSync(packages);
      for (let i = 0; i < 12; i += 1) mkdirSync(nodePath.join(packages, `p${i}`));
      const d = detectProjectShape({
        projectRoot: dir,
        packageJson: { name: 'monorepo', workspaces: ['packages/*', 'examples/*'], scripts: { dev: 'shrk', build: 'tsc' } },
      });
      expect(d.shape).toBe(ProjectShape.Monorepo);
    });
  });
});
