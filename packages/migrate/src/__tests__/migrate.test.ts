import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineMigration, planMigration, applyMigration } from '../index.ts';

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-migrate-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'a.ts'),
    [
      "import { debounce } from 'lodash';",
      "import _ from 'lodash';",
      "console.log('hi');",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'b.ts'),
    [
      "import { merge } from 'lodash';",
    ].join('\n'),
  );
  return root;
}

describe('defineMigration', () => {
  test('requires id, title, and non-empty steps', () => {
    expect(() => defineMigration({ id: '', title: 't', steps: [] as unknown as any })).toThrow(/id is required/);
    expect(() => defineMigration({ id: 'x', title: '', steps: [] as unknown as any })).toThrow(/title is required/);
    expect(() => defineMigration({ id: 'x', title: 't', steps: [] })).toThrow(/steps must be non-empty/);
  });

  test('returns the input with schema set', () => {
    const m = defineMigration({
      id: 'demo',
      title: 'Demo',
      steps: [{ kind: 'shell', command: 'echo hi' }],
    });
    expect(m.schema).toBe('sharkcraft.migration/v1');
    expect(m.steps.length).toBe(1);
  });
});

describe('planMigration', () => {
  test('expands structural-rewrite steps into their rewrite plans', () => {
    const root = setupProject();
    try {
      const m = defineMigration({
        id: 'lodash-es',
        title: 'Move lodash to lodash-es',
        steps: [
          {
            kind: 'structural-rewrite',
            id: 'rewrite-imports',
            pattern: { kind: 'ImportDeclaration', from: 'lodash' },
            recipe: { kind: 'replace-import-from', to: 'lodash-es' },
          },
          { kind: 'check', id: 'typecheck', command: 'true' },
        ],
      });
      const plan = planMigration(m, root);
      expect(plan.plannedSteps.length).toBe(2);
      expect(plan.totalFiles).toBe(2);
      expect(plan.totalEdits).toBe(3);
      const rw = plan.plannedSteps[0]!;
      expect(rw.rewritePlan).toBeDefined();
      expect(rw.rewritePlan!.totalEdits).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('applyMigration', () => {
  test('applies a structural rewrite + a passing check', () => {
    const root = setupProject();
    try {
      const m = defineMigration({
        id: 'lodash-es',
        title: 'Move lodash to lodash-es',
        steps: [
          {
            kind: 'structural-rewrite',
            pattern: { kind: 'ImportDeclaration', from: 'lodash' },
            recipe: { kind: 'replace-import-from', to: 'lodash-es' },
          },
          { kind: 'check', command: 'true' },
        ],
      });
      const report = applyMigration(m, { projectRoot: root });
      expect(report.overall).toBe('pass');
      expect(report.steps[0]!.status).toBe('applied');
      expect(report.steps[1]!.status).toBe('applied');
      const a = readFileSync(join(root, 'src', 'a.ts'), 'utf8');
      expect(a).toContain("'lodash-es'");
      expect(a).not.toContain("'lodash'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('halts on first failed check (default stopOnFailure=true)', () => {
    const root = setupProject();
    try {
      const m = defineMigration({
        id: 'demo',
        title: 'Demo',
        steps: [
          { kind: 'check', id: 'fails', command: 'exit 1' },
          { kind: 'shell', id: 'never', command: 'echo never' },
        ],
      });
      const report = applyMigration(m, { projectRoot: root });
      expect(report.overall).toBe('fail');
      expect(report.steps[0]!.status).toBe('failed');
      expect(report.steps[1]!.status).toBe('skipped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dryRun does not touch disk', () => {
    const root = setupProject();
    try {
      const m = defineMigration({
        id: 'demo',
        title: 'Demo',
        steps: [
          {
            kind: 'structural-rewrite',
            pattern: { kind: 'ImportDeclaration', from: 'lodash' },
            recipe: { kind: 'replace-import-from', to: 'lodash-es' },
          },
        ],
      });
      const before = readFileSync(join(root, 'src', 'a.ts'), 'utf8');
      const report = applyMigration(m, { projectRoot: root, dryRun: true });
      expect(report.overall).toBe('pass');
      expect(report.steps[0]!.status).toBe('planned');
      const after = readFileSync(join(root, 'src', 'a.ts'), 'utf8');
      expect(after).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
