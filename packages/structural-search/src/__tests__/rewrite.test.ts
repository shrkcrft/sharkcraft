import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRewrite } from '../engine/plan-rewrite.ts';
import { applyRewritePlan } from '../engine/apply-rewrite.ts';
import type { StructuralPattern } from '../schema/pattern.ts';
import type { RewriteRecipe } from '../schema/rewrite.ts';

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-rewrite-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'a.ts'),
    [
      "import { debounce } from 'lodash';",
      "import _ from 'lodash';",
      "import { each } from 'lodash-es';",
      "console.log('hi');",
      "console.log('bye');",
      "const useState = 1;",
      "console.warn('w');",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'b.ts'),
    [
      "import { merge } from 'lodash';",
      "console.log('b');",
    ].join('\n'),
  );
  return root;
}

describe('planRewrite', () => {
  test('replace-import-from changes a module specifier', () => {
    const root = setup();
    try {
      const pattern: StructuralPattern = { kind: 'ImportDeclaration', from: 'lodash' };
      const recipe: RewriteRecipe = { kind: 'replace-import-from', to: 'lodash-es' };
      const plan = planRewrite({ projectRoot: root, pattern, recipe });
      expect(plan.totalEdits).toBe(3); // a.ts has 2 lodash imports, b.ts has 1
      const aFile = plan.files.find((f) => f.path === 'src/a.ts')!;
      expect(aFile.edits.length).toBe(2);
      for (const e of aFile.edits) {
        expect(e.before).toBe('lodash');
        expect(e.replacement).toBe('lodash-es');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('replace-call-callee renames console.log to logger.info', () => {
    const root = setup();
    try {
      const pattern: StructuralPattern = {
        kind: 'CallExpression',
        callee: { kind: 'Identifier', name: 'log' },
      };
      const recipe: RewriteRecipe = { kind: 'replace-call-callee', to: 'logger.info' };
      const plan = planRewrite({ projectRoot: root, pattern, recipe });
      // 2 console.log in a.ts + 1 in b.ts = 3.
      expect(plan.totalEdits).toBe(3);
      const aFile = plan.files.find((f) => f.path === 'src/a.ts')!;
      for (const e of aFile.edits) {
        expect(e.before).toBe('console.log');
        expect(e.replacement).toBe('logger.info');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recipe-pattern kind mismatch emits a diagnostic and zero edits', () => {
    const root = setup();
    try {
      const pattern: StructuralPattern = { kind: 'Identifier', name: 'useState' };
      const recipe: RewriteRecipe = { kind: 'replace-import-from', to: 'whatever' };
      const plan = planRewrite({ projectRoot: root, pattern, recipe });
      expect(plan.totalEdits).toBe(0);
      expect(plan.diagnostics.some((d) => d.includes('expects pattern kind'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('applyRewritePlan', () => {
  test('writes the new file contents and tracks bytes written', () => {
    const root = setup();
    try {
      const pattern: StructuralPattern = { kind: 'ImportDeclaration', from: 'lodash' };
      const recipe: RewriteRecipe = { kind: 'replace-import-from', to: 'lodash-es' };
      const plan = planRewrite({ projectRoot: root, pattern, recipe });
      const result = applyRewritePlan(plan, { projectRoot: root });
      expect(result.filesChanged).toBe(2);
      expect(result.conflicts).toEqual([]);
      // Verify on-disk content has the new imports.
      const a = readFileSync(join(root, 'src', 'a.ts'), 'utf8');
      const matches = a.match(/'lodash-es'/g) ?? [];
      // 'lodash-es' should appear 3 times: 1 original + 2 newly written.
      expect(matches.length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dry-run does not touch disk', () => {
    const root = setup();
    try {
      const pattern: StructuralPattern = { kind: 'ImportDeclaration', from: 'lodash' };
      const recipe: RewriteRecipe = { kind: 'replace-import-from', to: 'lodash-es' };
      const plan = planRewrite({ projectRoot: root, pattern, recipe });
      const before = readFileSync(join(root, 'src', 'a.ts'), 'utf8');
      const result = applyRewritePlan(plan, { projectRoot: root, dryRun: true });
      expect(result.filesChanged).toBe(2);
      const after = readFileSync(join(root, 'src', 'a.ts'), 'utf8');
      expect(after).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects drift and skips files whose `before` no longer matches', () => {
    const root = setup();
    try {
      const pattern: StructuralPattern = { kind: 'ImportDeclaration', from: 'lodash' };
      const recipe: RewriteRecipe = { kind: 'replace-import-from', to: 'lodash-es' };
      const plan = planRewrite({ projectRoot: root, pattern, recipe });
      // Mutate one file out-of-band.
      writeFileSync(join(root, 'src', 'a.ts'), 'unrelated content', 'utf8');
      const result = applyRewritePlan(plan, { projectRoot: root });
      expect(result.conflicts).toContain('src/a.ts');
      // b.ts should still apply cleanly.
      expect(result.filesChanged).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
