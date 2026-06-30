import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanImports } from '../index.ts';

describe('scanImports symlink safety', () => {
  test('does not descend into a self-referential symlink loop', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-scan-symlink-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), "import 'real';");
      // src/loop -> src : a directory symlink that loops back onto its parent.
      // A naive walker would recurse src/loop/loop/loop/... until PATH_MAX.
      symlinkSync(join(root, 'src'), join(root, 'src', 'loop'), 'dir');

      const r = scanImports({ projectRoot: root });

      // No node path may pass through the symlink at all.
      for (const e of r.edges) {
        expect(e.from).not.toContain('loop');
      }
      expect(r.filesScanned).toBe(1);
      const specs = r.edges.map((e) => e.importSpecifier);
      expect(specs).toEqual(['real']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not scan a symlink pointing at an external tree', () => {
    const real = mkdtempSync(join(tmpdir(), 'shrk-scan-symlink-real-'));
    const external = mkdtempSync(join(tmpdir(), 'shrk-scan-symlink-ext-'));
    try {
      mkdirSync(join(real, 'src'), { recursive: true });
      writeFileSync(join(real, 'src', 'a.ts'), "import 'real';");
      // Populate an unrelated external directory the link points at.
      writeFileSync(join(external, 'b.ts'), "import 'external';");
      writeFileSync(join(external, 'c.ts'), "import 'external-too';");
      symlinkSync(external, join(real, 'src', 'vendor'), 'dir');

      const r = scanImports({ projectRoot: real });

      const specs = r.edges.map((e) => e.importSpecifier);
      expect(specs).toContain('real');
      expect(specs).not.toContain('external');
      expect(specs).not.toContain('external-too');
      expect(r.filesScanned).toBe(1);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
