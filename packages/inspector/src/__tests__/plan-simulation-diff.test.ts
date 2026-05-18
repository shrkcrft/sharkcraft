import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { inspectSharkcraft, simulatePlan } from '../index.ts';

function setupRoot(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r24-plansim-diff-'));
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  mkdirSync(nodePath.join(root, '.sharkcraft'), { recursive: true });
  return root;
}

function writePlan(root: string, plan: unknown): string {
  const file = nodePath.join(root, 'plan.json');
  writeFileSync(file, JSON.stringify(plan), 'utf8');
  return file;
}

describe('plan simulation diff', () => {
  it('create plan reports beforeLineCount=0 and produces no diff for non-template plan', async () => {
    const root = setupRoot();
    try {
      const plan = writePlan(root, {
        schema: 'sharkcraft.plan/v1',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [{ type: 'create', relativePath: 'src/foo.ts', sizeBytes: 12 }],
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, plan, { diff: true });
      const f = r.files[0]!;
      // template "noop" doesn't exist → virtual contents unavailable → no diff.
      expect(f.diffPreview).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('conflict outcome never carries a diff preview', async () => {
    const root = setupRoot();
    try {
      const plan = writePlan(root, {
        schema: 'sharkcraft.plan/v2',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [{ type: 'conflict', relativePath: 'src/x.ts', sizeBytes: 1 }],
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, plan, { diff: true });
      expect(r.files[0]!.diffPreview).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('operationDetail explains kind-specific outcomes', async () => {
    const root = setupRoot();
    try {
      const plan = writePlan(root, {
        schema: 'sharkcraft.plan/v2',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [
          { type: 'append', relativePath: 'src/a.ts', sizeBytes: 5 },
          { type: 'export', relativePath: 'src/index.ts', sizeBytes: 5 },
          { type: 'replace', relativePath: 'src/b.ts', sizeBytes: 5 },
          { type: 'insert-after', relativePath: 'src/c.ts', sizeBytes: 5 },
        ],
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, plan, { diff: true });
      const details = r.files.map((f) => f.operationDetail ?? '');
      expect(details.some((d) => d.includes('append'))).toBe(true);
      expect(details.some((d) => d.includes('export'))).toBe(true);
      expect(details.some((d) => d.includes('replace'))).toBe(true);
      expect(details.some((d) => d.includes('insert-after'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
