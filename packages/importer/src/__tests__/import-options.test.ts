import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importAgentsMd, importClaudeMd, importCursorRules } from '../index.ts';

function tmpFile(content: string, name = 'AGENTS.md'): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-import-opts-'));
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return { dir, path };
}

const SIMPLE_MD = `## Coding Standards

- Always use 2-space indentation.
- Prefer interfaces over type aliases.

## Paths

- Services live in src/services/.
`;

describe('importer options', () => {
  test('--prefix overrides the id prefix deterministically', () => {
    const { dir, path } = tmpFile(SIMPLE_MD);
    try {
      const r1 = importAgentsMd({ filePath: path, projectRoot: dir });
      const r2 = importAgentsMd({ filePath: path, projectRoot: dir, idPrefix: 'demo.agents' });
      expect(r1.entries[0]?.id.startsWith('agents.')).toBe(true);
      expect(r2.entries[0]?.id.startsWith('demo.agents.')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--tag appends tags to every entry without duplicates', () => {
    const { dir, path } = tmpFile(SIMPLE_MD);
    try {
      const r = importClaudeMd({
        filePath: path,
        projectRoot: dir,
        extraTags: ['imported', 'demo'],
      });
      for (const e of r.entries) {
        expect(e.tags).toContain('imported');
        expect(e.tags).toContain('demo');
      }
      // No duplicates.
      const e0 = r.entries[0]!;
      expect(new Set(e0.tags).size).toBe(e0.tags.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--scope tokens land on every entry', () => {
    const { dir, path } = tmpFile(SIMPLE_MD);
    try {
      const r = importAgentsMd({
        filePath: path,
        projectRoot: dir,
        scope: ['angular', 'typescript'],
      });
      for (const e of r.entries) {
        expect(e.tags).toContain('angular');
        expect(e.tags).toContain('typescript');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('IDs are deterministic across invocations on the same input', () => {
    const { dir, path } = tmpFile(SIMPLE_MD);
    try {
      const a = importAgentsMd({ filePath: path, projectRoot: dir });
      const b = importAgentsMd({ filePath: path, projectRoot: dir });
      const idsA = a.entries.map((e) => e.id);
      const idsB = b.entries.map((e) => e.id);
      expect(idsA).toEqual(idsB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cursor --prefix flows through to per-file ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-cursor-opts-'));
    try {
      const file = join(dir, 'a.mdc');
      writeFileSync(
        file,
        `---\ndescription: Demo rule\n---\n- body`,
        'utf8',
      );
      const r = importCursorRules({ filePath: file, projectRoot: dir, idPrefix: 'team' });
      expect(r.entries[0]?.id.startsWith('team.a.')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
