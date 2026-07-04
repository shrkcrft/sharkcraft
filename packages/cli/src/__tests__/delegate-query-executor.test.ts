import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { buildAnalysisQueryExecutor } from '../commands/delegate.command.ts';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-query-exec-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  return root;
}

describe('buildAnalysisQueryExecutor', () => {
  test('task-risk / coverage / test-impact queries return read-only facts + entities', async () => {
    const root = project();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const exec = buildAnalysisQueryExecutor(inspection, 'refactor the index');
      const risk = await exec('task-risk', {});
      expect(risk.content).toContain('risk=');
      const cov = await exec('coverage', {});
      expect(cov.content).toContain('overall=');
      const ti = await exec('test-impact', { files: ['src/index.ts'] });
      expect(ti.content).toContain('existing:');
      expect(Array.isArray(ti.entities)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('graph queries degrade cleanly when the graph index is missing', async () => {
    const root = project();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const exec = buildAnalysisQueryExecutor(inspection, 't');
      const callers = await exec('graph-callers', { symbol: 'a' });
      expect(callers.content).toContain('graph index missing');
      expect(callers.entities).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unknown query returns a benign message (never throws)', async () => {
    const root = project();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const exec = buildAnalysisQueryExecutor(inspection, 't');
      const r = await exec('not-a-query', {});
      expect(r.content).toContain('unknown query');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
