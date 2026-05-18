import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { buildRepositoryStats, REPOSITORY_STATS_SCHEMA } from '../index.ts';

function setupFixture(root: string): void {
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  mkdirSync(nodePath.join(root, 'src'), { recursive: true });
  mkdirSync(nodePath.join(root, 'src/lib'), { recursive: true });
  mkdirSync(nodePath.join(root, 'node_modules/should-be-ignored'), { recursive: true });

  // 3 TS files, 1 with a block comment, 1 trivial
  writeFileSync(
    nodePath.join(root, 'src/index.ts'),
    [
      '// header comment',
      'export const A = 1;',
      '',
      '/*',
      ' * block comment line',
      ' */',
      'export const B = 2;',
    ].join('\n') + '\n',
  );
  writeFileSync(
    nodePath.join(root, 'src/lib/util.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );
  writeFileSync(nodePath.join(root, 'src/lib/empty.ts'), '');

  // Python file: 2 code, 1 hash comment, 1 blank
  writeFileSync(
    nodePath.join(root, 'main.py'),
    ['# entrypoint', 'print("hi")', '', 'x = 1'].join('\n') + '\n',
  );

  // README markdown
  writeFileSync(nodePath.join(root, 'README.md'), '# Title\n\nbody\n');

  // Inside node_modules — must be excluded
  writeFileSync(nodePath.join(root, 'node_modules/should-be-ignored/index.ts'), 'export const Z = 1;\n');
}

describe('buildRepositoryStats', () => {
  it('counts files per language and respects the ignored-dir list', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-'));
    try {
      setupFixture(root);
      const stats = await buildRepositoryStats({ cwd: root });

      expect(stats.schema).toBe(REPOSITORY_STATS_SCHEMA);
      expect(stats.truncated).toBe(false);

      const ts = stats.byLanguage.find((l) => l.language === 'typescript');
      expect(ts).toBeDefined();
      expect(ts!.files).toBe(3);
      // node_modules should be excluded — no 4th TS file leaks in
      const tsPaths = stats.topFiles
        .filter((f) => f.language === 'typescript')
        .map((f) => f.path);
      expect(tsPaths.every((p) => !p.includes('node_modules'))).toBe(true);

      const py = stats.byLanguage.find((l) => l.language === 'python');
      expect(py).toBeDefined();
      expect(py!.files).toBe(1);
      expect(py!.codeLines).toBe(2);
      expect(py!.commentLines).toBe(1);
      expect(py!.blankLines).toBe(1);

      const md = stats.byLanguage.find((l) => l.language === 'markdown');
      expect(md).toBeDefined();
      expect(md!.files).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles block comments and counts comment lines correctly', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-'));
    try {
      setupFixture(root);
      const stats = await buildRepositoryStats({ cwd: root });
      const ts = stats.byLanguage.find((l) => l.language === 'typescript')!;
      // src/index.ts: 1 line comment + 3 lines of block comment = 4 comment lines
      // util.ts: 0 comments. empty.ts: 0.
      expect(ts.commentLines).toBeGreaterThanOrEqual(4);
      expect(ts.codeLines).toBeGreaterThan(0);
      expect(ts.blankLines).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('filters to a single language when requested', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-'));
    try {
      setupFixture(root);
      const stats = await buildRepositoryStats({ cwd: root, language: 'python' });
      expect(stats.byLanguage.length).toBe(1);
      expect(stats.byLanguage[0]!.language).toBe('python');
      expect(stats.topFiles.every((f) => f.language === 'python')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects maxTopFiles', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-'));
    try {
      setupFixture(root);
      const stats = await buildRepositoryStats({ cwd: root, maxTopFiles: 2 });
      expect(stats.topFiles.length).toBeLessThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aggregates totals across all languages', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-stats-'));
    try {
      setupFixture(root);
      const stats = await buildRepositoryStats({ cwd: root });
      const fileSum = stats.byLanguage.reduce((s, l) => s + l.files, 0);
      expect(stats.totals.files).toBe(fileSum);
      const bytesSum = stats.byLanguage.reduce((s, l) => s + l.bytes, 0);
      expect(stats.totals.bytes).toBe(bytesSum);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
