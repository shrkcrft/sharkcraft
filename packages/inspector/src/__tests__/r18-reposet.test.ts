import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { buildReposetMap, loadReposetConfig, previewReposetInit } from '../index.ts';

describe('r18 reposet', () => {
  test('preview init returns valid JSON', () => {
    const root = nodePath.join(tmpdir(), `r18-reposet-init-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
      const p = previewReposetInit(root);
      expect(() => JSON.parse(p.body)).not.toThrow();
      expect(p.targetPath.endsWith('sharkcraft.reposet.json')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('loadReposetConfig + buildReposetMap detects missing repos', async () => {
    const root = nodePath.join(tmpdir(), `r18-reposet-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      nodePath.join(root, 'sharkcraft.reposet.json'),
      JSON.stringify({
        schema: 'sharkcraft.reposet/v1',
        repos: [
          { id: 'present', name: 'present', root: root, tags: [], role: 'engine' },
          { id: 'missing', name: 'missing', root: nodePath.join(root, 'does-not-exist'), tags: [], role: 'consumer' },
        ],
      }),
    );
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'present', version: '0.0.0', private: true }),
    );
    try {
      const cfg = loadReposetConfig(root)!;
      expect(cfg.repos.length).toBe(2);
      const map = await buildReposetMap(cfg);
      expect(map.repos.find((r) => r.id === 'missing')!.exists).toBe(false);
      expect(map.repos.find((r) => r.id === 'present')!.exists).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
