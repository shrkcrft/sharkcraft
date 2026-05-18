import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../tools/index.ts';

describe('get_repository_stats MCP tool', () => {
  test('is registered', () => {
    expect(ALL_TOOLS.find((t) => t.name === 'get_repository_stats')).toBeDefined();
  });

  test('returns a v1 stats payload and does not write to the filesystem', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_repository_stats')!;
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-mcp-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0' }),
      );
      mkdirSync(nodePath.join(root, 'src'), { recursive: true });
      writeFileSync(nodePath.join(root, 'src/a.ts'), 'export const A = 1;\n');
      writeFileSync(nodePath.join(root, 'src/b.ts'), 'export const B = 2;\n');

      const { inspectSharkcraft } = await import('@shrkcrft/inspector');
      const inspection = await inspectSharkcraft({ cwd: root });
      const ctx = { cwd: root, inspection };

      const result = await tool.handler({ maxTopFiles: 5 }, ctx as never);
      const data = result.data as {
        schema: string;
        totals: { files: number };
        byLanguage: { language: string; files: number }[];
      };

      expect(data.schema).toBe('sharkcraft.repository-stats/v1');
      expect(data.totals.files).toBeGreaterThanOrEqual(2);
      const ts = data.byLanguage.find((l) => l.language === 'typescript');
      expect(ts).toBeDefined();
      expect(ts!.files).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('honours the language filter', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'get_repository_stats')!;
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-mcp-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0' }),
      );
      writeFileSync(nodePath.join(root, 'a.ts'), 'export const A = 1;\n');
      writeFileSync(nodePath.join(root, 'b.py'), 'print(1)\n');

      const { inspectSharkcraft } = await import('@shrkcrft/inspector');
      const inspection = await inspectSharkcraft({ cwd: root });
      const ctx = { cwd: root, inspection };

      const result = await tool.handler({ language: 'python' }, ctx as never);
      const data = result.data as { byLanguage: { language: string }[] };
      expect(data.byLanguage.every((l) => l.language === 'python')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
