import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectWorkspacePackages } from '../detect-workspace.ts';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'shrk-detect-ws-'));
}

function writePkg(root: string, dir: string, body: Record<string, unknown>): void {
  const abs = join(root, dir);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'package.json'), JSON.stringify(body, null, 2));
}

function writeRoot(root: string, workspaces: unknown): void {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', private: true, workspaces }, null, 2),
  );
}

describe('detectWorkspacePackages', () => {
  test('flat layout: packages/<pkg>/package.json is discovered (one level)', () => {
    const root = tmpRoot();
    try {
      writeRoot(root, ['packages/*']);
      writePkg(root, 'packages/alpha', { name: '@demo/alpha', main: 'src/index.ts' });
      writePkg(root, 'packages/beta', { name: '@demo/beta' });

      const found = detectWorkspacePackages(root);
      expect(found.map((p) => p.name)).toEqual(['@demo/alpha', '@demo/beta']);
      const alpha = found.find((p) => p.name === '@demo/alpha');
      expect(alpha?.dir).toBe('packages/alpha');
      expect(alpha?.entry).toBe('packages/alpha/src/index.ts');
      // No entry field when package.json declares no main/module/types.
      expect(found.find((p) => p.name === '@demo/beta')?.entry).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('nested layout: packages/<group>/<pkg>/package.json is discovered', () => {
    const root = tmpRoot();
    try {
      writeRoot(root, ['packages/*']);
      writePkg(root, 'packages/group/pkg1', { name: '@demo/pkg1', main: 'index.ts' });
      writePkg(root, 'packages/group/pkg2', { name: '@demo/pkg2' });

      const found = detectWorkspacePackages(root);
      expect(found.map((p) => p.name)).toEqual(['@demo/pkg1', '@demo/pkg2']);
      expect(found.find((p) => p.name === '@demo/pkg1')?.dir).toBe('packages/group/pkg1');
      expect(found.find((p) => p.name === '@demo/pkg2')?.dir).toBe('packages/group/pkg2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mixed flat + nested under the same glob are both discovered', () => {
    const root = tmpRoot();
    try {
      writeRoot(root, ['packages/*']);
      writePkg(root, 'packages/flat', { name: '@demo/flat' });
      writePkg(root, 'packages/group/nested', { name: '@demo/nested' });

      const found = detectWorkspacePackages(root);
      expect(found.map((p) => p.name)).toEqual(['@demo/flat', '@demo/nested']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a package directory is a leaf — inner package.json is not double-counted', () => {
    const root = tmpRoot();
    try {
      writeRoot(root, ['packages/*']);
      writePkg(root, 'packages/alpha', { name: '@demo/alpha' });
      // A fixture inside the package carrying its own package.json must be
      // ignored — descent stops at the package root.
      writePkg(root, 'packages/alpha/test/fixture', { name: '@demo/alpha-fixture' });

      const found = detectWorkspacePackages(root);
      expect(found.map((p) => p.name)).toEqual(['@demo/alpha']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('node_modules is pruned during the recursive walk', () => {
    const root = tmpRoot();
    try {
      writeRoot(root, ['packages/*']);
      writePkg(root, 'packages/alpha', { name: '@demo/alpha' });
      // A dependency package.json must never surface as a workspace package.
      writePkg(root, 'packages/node_modules/leftpad', { name: 'leftpad' });

      const found = detectWorkspacePackages(root);
      expect(found.map((p) => p.name)).toEqual(['@demo/alpha']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('symlinked directories are not followed', () => {
    const root = tmpRoot();
    try {
      writeRoot(root, ['packages/*']);
      writePkg(root, 'packages/alpha', { name: '@demo/alpha' });
      // An external package the symlink would otherwise expose.
      writePkg(root, 'external/secret', { name: '@demo/secret' });
      symlinkSync(join(root, 'external'), join(root, 'packages', 'linked'), 'dir');

      const found = detectWorkspacePackages(root);
      expect(found.map((p) => p.name)).toEqual(['@demo/alpha']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('object workspaces form ({ packages: [...] }) is honored', () => {
    const root = tmpRoot();
    try {
      writeRoot(root, { packages: ['packages/*'] });
      writePkg(root, 'packages/group/pkg1', { name: '@demo/pkg1' });

      const found = detectWorkspacePackages(root);
      expect(found.map((p) => p.name)).toEqual(['@demo/pkg1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no package.json at root → empty result', () => {
    const root = tmpRoot();
    try {
      expect(detectWorkspacePackages(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
