import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTemplate, type ITemplateChange } from '@shrkcrft/templates';
import { evaluateSavedPlanInPlace, writeSyntheticPlan } from '../synthetic-plan.ts';
import { generate } from '../generator-engine.ts';
import type { IPlannedOperation } from '../planned-change.ts';
import type { ISavedPlan } from '../saved-plan.ts';

interface IOp {
  relativePath: string;
  operation: IPlannedOperation;
}

function savedPlan(root: string, ops: readonly IOp[]): ISavedPlan {
  return {
    schema: 'sharkcraft.plan/v2',
    templateId: '__delegate/overlay-test',
    variables: {},
    projectRoot: root,
    createdAt: new Date().toISOString(),
    expectedChanges: ops.map((o) => ({
      type: 'pending',
      relativePath: o.relativePath,
      sizeBytes: 0,
      operation: o.operation,
    })),
  };
}

describe('synthetic-plan — same-file ops compose via overlay', () => {
  test('two appends to an existing file compose: BOTH snippets, in order, no conflict', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-overlay-2append-'));
    try {
      writeFileSync(join(root, 'notes.txt'), 'line0\n');
      const plan = evaluateSavedPlanInPlace(
        savedPlan(root, [
          { relativePath: 'notes.txt', operation: { kind: 'append', snippet: 'AAA' } },
          { relativePath: 'notes.txt', operation: { kind: 'append', snippet: 'BBB' } },
        ]),
        root,
      );
      // Without the overlay the second append clobbers the first; with it they
      // compose and neither becomes a false conflict.
      expect(plan.hasConflicts).toBe(false);

      const w = writeSyntheticPlan(plan);
      expect(w.ok).toBe(true);

      const contents = readFileSync(join(root, 'notes.txt'), 'utf8');
      expect(contents).toBe('line0\nAAA\nBBB');
      expect(contents.indexOf('AAA')).toBeLessThan(contents.indexOf('BBB'));
      // Honest count: one DISTINCT path was written, not two.
      if (w.ok) expect(w.value.summary.written).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('create-then-append to a NEW path: no false conflict, file holds both', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-overlay-create-append-'));
    try {
      const plan = evaluateSavedPlanInPlace(
        savedPlan(root, [
          {
            relativePath: 'src/fresh.ts',
            operation: { kind: 'create', content: 'export const a = 1;\n' },
          },
          {
            relativePath: 'src/fresh.ts',
            operation: { kind: 'append', snippet: 'export const b = 2;\n' },
          },
        ]),
        root,
      );
      // The append must see the in-flight CREATE (overlay), not stale disk —
      // otherwise the file "does not exist" and the op false-conflicts.
      expect(plan.hasConflicts).toBe(false);

      const w = writeSyntheticPlan(plan);
      expect(w.ok).toBe(true);

      const contents = readFileSync(join(root, 'src/fresh.ts'), 'utf8');
      expect(contents).toBe('export const a = 1;\nexport const b = 2;\n');
      if (w.ok) expect(w.value.summary.written).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parity: same op list via template (planGeneration) and synthetic yields identical bytes per path', () => {
    const ops: ITemplateChange[] = [
      { targetPath: 'notes.txt', operation: { kind: 'append', snippet: 'AAA' } },
      { targetPath: 'notes.txt', operation: { kind: 'append', snippet: 'BBB' } },
      {
        targetPath: 'src/fresh.ts',
        operation: { kind: 'create', content: 'export const a = 1;\n' },
      },
      {
        targetPath: 'src/fresh.ts',
        operation: { kind: 'append', snippet: 'export const b = 2;\n' },
      },
    ];

    const tpl = defineTemplate({
      id: 'parity.overlay',
      name: 'Parity overlay',
      description: 'parity fixture',
      tags: [],
      scope: [],
      appliesWhen: [],
      variables: [],
      changes: () => ops,
    });

    const rootTpl = mkdtempSync(join(tmpdir(), 'shrk-overlay-parity-tpl-'));
    const rootSyn = mkdtempSync(join(tmpdir(), 'shrk-overlay-parity-syn-'));
    try {
      // Identical starting state in both worktrees.
      writeFileSync(join(rootTpl, 'notes.txt'), 'line0\n');
      writeFileSync(join(rootSyn, 'notes.txt'), 'line0\n');

      // Template (canonical) write path.
      const gen = generate(tpl, {
        templateId: tpl.id,
        variables: {},
        projectRoot: rootTpl,
        write: true,
      });
      expect(gen.ok).toBe(true);

      // Synthetic write path with the same op list.
      const plan = evaluateSavedPlanInPlace(
        savedPlan(
          rootSyn,
          ops.map((o) => ({ relativePath: o.targetPath, operation: o.operation })),
        ),
        rootSyn,
      );
      expect(plan.hasConflicts).toBe(false);
      const w = writeSyntheticPlan(plan);
      expect(w.ok).toBe(true);

      // Identical final bytes per path.
      for (const rel of ['notes.txt', 'src/fresh.ts']) {
        const tplBytes = readFileSync(join(rootTpl, rel), 'utf8');
        const synBytes = readFileSync(join(rootSyn, rel), 'utf8');
        expect(synBytes).toBe(tplBytes);
      }
    } finally {
      rmSync(rootTpl, { recursive: true, force: true });
      rmSync(rootSyn, { recursive: true, force: true });
    }
  });
});
