import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { decomposeTask, inspectSharkcraft, TaskVerb } from '../index.ts';

describe('task decompose', () => {
  it('detects verbs and domain hints', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-dec-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = decomposeTask(inspection, 'create a user profile plugin');
      expect(r.verb).toBe(TaskVerb.Create);
      expect(r.domainHints).toContain('plugin');
      expect(r.subtasks.length).toBeGreaterThan(1);
      expect(r.recommendedOrder[0]).toBe(r.subtasks[0]?.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles fix verb', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-dec-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = decomposeTask(inspection, 'fix bug in cli');
      expect(r.verb).toBe(TaskVerb.Fix);
      // Fix path adds reproduce + regression test steps.
      expect(r.subtasks.some((s) => /reproduce/i.test(s.id) || /regression/i.test(s.id))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
