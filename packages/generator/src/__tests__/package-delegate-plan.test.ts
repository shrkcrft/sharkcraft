import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageDelegatePlan, DELEGATE_TEMPLATE_PREFIX } from '../package-delegate-plan.ts';

function project(barrel: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-pkg-delegate-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), barrel);
  return root;
}

describe('packageDelegatePlan', () => {
  test('builds a signed-ready synthetic plan from an allowed export op', () => {
    const root = project("export * from './a';\n");
    try {
      const r = packageDelegatePlan({
        ops: [{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './b' } }],
        allowedOps: ['export'],
        recipeId: 'add-barrel-export',
        projectRoot: root,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.ready).toBe(true);
        expect(r.value.plan?.templateId).toBe(`${DELEGATE_TEMPLATE_PREFIX}add-barrel-export`);
        expect(r.value.plan?.expectedChanges?.[0]?.operation?.kind).toBe('export');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('drops an op whose kind is not in allowedOps (never packaged)', () => {
    const root = project("export * from './a';\n");
    try {
      const r = packageDelegatePlan({
        ops: [
          { targetPath: 'src/index.ts', operation: { kind: 'export', from: './b' } },
          { targetPath: 'src/index.ts', operation: { kind: 'replace', find: 'x', replaceWith: 'y' } },
        ],
        allowedOps: ['export'],
        recipeId: 'add-barrel-export',
        projectRoot: root,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.droppedOps.map((d) => d.kind)).toEqual(['replace']);
        // Only the allowed export op was packaged.
        expect(r.value.plan?.expectedChanges).toHaveLength(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses a malformed allowed op (export missing `from`)', () => {
    const root = project("export * from './a';\n");
    try {
      const r = packageDelegatePlan({
        ops: [{ targetPath: 'src/index.ts', operation: { kind: 'export' } }],
        allowedOps: ['export'],
        recipeId: 'add-barrel-export',
        projectRoot: root,
      });
      expect(r.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('surfaces a conflict (export to a non-existent barrel) as ready:false, no plan', () => {
    const root = project("export * from './a';\n");
    try {
      const r = packageDelegatePlan({
        ops: [{ targetPath: 'src/does-not-exist.ts', operation: { kind: 'export', from: './b' } }],
        allowedOps: ['export'],
        recipeId: 'add-barrel-export',
        projectRoot: root,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.ready).toBe(false);
        expect(r.value.plan).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('errors when every op is of a disallowed kind', () => {
    const root = project("export * from './a';\n");
    try {
      const r = packageDelegatePlan({
        ops: [{ targetPath: 'src/index.ts', operation: { kind: 'replace', find: 'x', replaceWith: 'y' } }],
        allowedOps: ['export'],
        recipeId: 'add-barrel-export',
        projectRoot: root,
      });
      expect(r.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
