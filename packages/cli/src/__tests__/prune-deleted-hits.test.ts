import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneDeletedHits } from '@shrkcrft/embeddings';

function project(existing: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-prune-hits-'));
  for (const rel of existing) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), '// x\n');
  }
  return root;
}

describe('pruneDeletedHits (semantic freshness-in-the-moment)', () => {
  test('drops hits whose file is gone from disk, keeps the live ones in order', () => {
    const root = project(['src/a.ts', 'src/c.ts']);
    try {
      const hits = [
        { path: 'src/a.ts', score: 0.9 },
        { path: 'src/deleted.ts', score: 0.85 }, // gone
        { path: 'src/c.ts', score: 0.8 },
      ];
      const r = pruneDeletedHits(hits, root, 5);
      expect(r.hits.map((h) => h.path)).toEqual(['src/a.ts', 'src/c.ts']);
      expect(r.prunedDeleted).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('caps at k live results, preserving score order', () => {
    const root = project(['a.ts', 'b.ts', 'c.ts']);
    try {
      const hits = [
        { path: 'a.ts', score: 0.9 },
        { path: 'b.ts', score: 0.8 },
        { path: 'c.ts', score: 0.7 },
      ];
      const r = pruneDeletedHits(hits, root, 2);
      expect(r.hits.map((h) => h.path)).toEqual(['a.ts', 'b.ts']);
      expect(r.prunedDeleted).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('all-deleted index yields no hits (never suggests a dead file)', () => {
    const root = project([]);
    try {
      const r = pruneDeletedHits([{ path: 'ghost.ts', score: 0.99 }], root, 5);
      expect(r.hits).toHaveLength(0);
      expect(r.prunedDeleted).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
