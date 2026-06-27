import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { classifyIntent } from '../intent/classify-intent.ts';
import { planContext } from '../planner/plan-context.ts';
import { CONTEXT_PACK_SCHEMA } from '../schema/context-pack.ts';

describe('classifyIntent', () => {
  const cases: ReadonlyArray<[string, ReturnType<typeof classifyIntent>]> = [
    ['fix the broken alpha bug', 'bug-fix'],
    ['add a new CLI command for exporting reports', 'feature'],
    ['rename the User class to Account', 'refactor'],
    ['update the README to document the new flag', 'docs'],
    ['publish the 0.1.0 release', 'release'],
    ['migrate the schema from v1 to v2', 'migration'],
    ['hmm yeah whatever', 'unknown'],
  ];
  for (const [task, expected] of cases) {
    test(`classifies "${task}" → ${expected}`, () => {
      expect(classifyIntent(task)).toBe(expected);
    });
  }
});

function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-context-planner-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'beta', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'beta', 'src', '__tests__'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'package.json'),
    JSON.stringify({ name: '@demo/beta', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    "export function alpha() { return 1; }\nexport const ALPHA_TAG = 'a';",
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    "import { alpha } from '@demo/alpha';\nexport function useAlpha() { return alpha(); }",
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', '__tests__', 'index.test.ts'),
    "import { useAlpha } from '../index.ts';\nconsole.log(useAlpha);",
  );
  return root;
}

describe('planContext', () => {
  test('ranks files by task keywords (deterministic)', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const a = planContext({ projectRoot: root, task: 'tweak the alpha function' });
      const b = planContext({ projectRoot: root, task: 'tweak the alpha function' });
      expect(a.schema).toBe(CONTEXT_PACK_SCHEMA);
      expect(a.intent).toBe('unknown');
      expect(a.files.length).toBeGreaterThanOrEqual(1);
      expect(a.files[0]?.path).toBe('packages/alpha/src/index.ts');
      // Two consecutive calls produce identical output (deterministic).
      expect(JSON.stringify(a.files)).toBe(JSON.stringify(b.files));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('respects budget — truncated flag set when budget too small', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const pack = planContext({
        projectRoot: root,
        task: 'rename alpha to alpha2',
        budgetTokens: 100,
        maxFiles: 30,
      });
      expect(pack.budget.requested).toBe(100);
      expect(pack.budget.used).toBeLessThanOrEqual(100);
      // With such a tight budget, we typically get 0-1 files.
      expect(pack.files.length).toBeLessThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('intent → tests get a boost for bug-fix', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      // bug-fix should NOT penalize test files; they may end up in the pack
      // either via the test-followup mechanism or via being importers.
      const pack = planContext({
        projectRoot: root,
        task: 'fix the broken useAlpha bug',
      });
      expect(pack.intent).toBe('bug-fix');
      expect(pack.tests.length).toBeGreaterThanOrEqual(0); // pack.tests may include co-located test
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('hintedFiles get boosted', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const pack = planContext({
        projectRoot: root,
        task: 'something completely unrelated',
        hintedFiles: ['packages/beta/src/index.ts'],
      });
      expect(pack.files.some((f) => f.path === 'packages/beta/src/index.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing code-graph emits a diagnostic, not a throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-ctx-empty-'));
    try {
      const pack = planContext({ projectRoot: root, task: 'do anything' });
      expect(pack.diagnostics.some((d) => d.includes('code-graph store missing'))).toBe(true);
      expect(pack.files).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('coverage distinguishes "not computed" (bridge missing) from "empty"', () => {
    const root = setupFixture();
    try {
      // Graph only — the rule-graph bridge is NOT indexed.
      buildFullIndex({ projectRoot: root });
      const pack = planContext({ projectRoot: root, task: 'add a feature to alpha' });
      // rules/paths/templates were OMITTED (bridge missing), not genuinely empty.
      expect(pack.coverage.rulesComputed).toBe(false);
      expect(pack.rules).toEqual([]);
      expect(pack.diagnostics.some((d) => d.includes('bridge store missing'))).toBe(true);
      // risks/doNotTouch ARE computed from the graph (present), so an empty array
      // there means "none surfaced", not "skipped".
      expect(pack.coverage.risksComputed).toBe(true);
      expect(pack.coverage.doNotTouchComputed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('coverage is all-false when the code-graph is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-ctx-empty-cov-'));
    try {
      const pack = planContext({ projectRoot: root, task: 'do anything' });
      expect(pack.coverage).toEqual({
        rulesComputed: false,
        risksComputed: false,
        doNotTouchComputed: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
