import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineMigration, applyMigration, resumeMigration, MigrationStateStore, findResumePoint } from '../index.ts';

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-migrate-resume-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), "import { foo } from 'lodash';");
  return root;
}

describe('MigrationStateStore + findResumePoint', () => {
  test('writes and reads back a run report', () => {
    const root = setup();
    try {
      const store = new MigrationStateStore(root);
      expect(store.exists('demo')).toBe(false);
      store.write('demo', {
        schema: 'sharkcraft.migration-run/v1',
        migration: { id: 'demo', title: 'Demo' },
        dryRun: false,
        startedAt: 'now',
        totalDurationMs: 1,
        overall: 'fail',
        steps: [
          { index: 0, id: 's1', kind: 'shell', status: 'applied', message: '', durationMs: 1, diagnostics: [] },
          { index: 1, id: 's2', kind: 'check', status: 'failed', message: 'boom', durationMs: 1, diagnostics: [] },
        ],
      });
      const back = store.read('demo')!;
      expect(back.steps.length).toBe(2);
      expect(findResumePoint(back)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('findResumePoint returns undefined when fully complete', () => {
    expect(
      findResumePoint({
        schema: 'sharkcraft.migration-run/v1',
        migration: { id: 'demo', title: 'Demo' },
        dryRun: false,
        startedAt: 'now',
        totalDurationMs: 1,
        overall: 'pass',
        steps: [
          { index: 0, id: 's1', kind: 'shell', status: 'applied', message: '', durationMs: 1, diagnostics: [] },
          { index: 1, id: 's2', kind: 'shell', status: 'applied', message: '', durationMs: 1, diagnostics: [] },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('applyMigration → resumeMigration end-to-end', () => {
  test('per-step checkpoints are written; resume continues from failed step', () => {
    const root = setup();
    try {
      // Migration with 3 steps; the 2nd fails.
      const m = defineMigration({
        id: 'demo',
        title: 'Demo',
        steps: [
          {
            kind: 'structural-rewrite',
            id: 'rewrite',
            pattern: { kind: 'ImportDeclaration', from: 'lodash' },
            recipe: { kind: 'replace-import-from', to: 'lodash-es' },
          },
          { kind: 'check', id: 'will-fail', command: 'exit 1' },
          { kind: 'shell', id: 'never-on-first-run', command: 'echo never' },
        ],
      });

      // First run halts on step 2.
      const first = applyMigration(m, { projectRoot: root });
      expect(first.overall).toBe('fail');
      expect(first.steps[0]!.status).toBe('applied');
      expect(first.steps[1]!.status).toBe('failed');
      expect(first.steps[2]!.status).toBe('skipped');

      // Checkpoint was persisted.
      const statePath = join(root, '.sharkcraft', 'migrations', 'demo.state.json');
      expect(existsSync(statePath)).toBe(true);
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(saved.overall).toBe('fail');

      // Fix the failing step by swapping it for a passing check.
      const m2 = defineMigration({
        id: 'demo',
        title: 'Demo',
        steps: [
          {
            kind: 'structural-rewrite',
            id: 'rewrite',
            pattern: { kind: 'ImportDeclaration', from: 'lodash' },
            recipe: { kind: 'replace-import-from', to: 'lodash-es' },
          },
          { kind: 'check', id: 'will-fail', command: 'true' }, // now passes
          { kind: 'shell', id: 'never-on-first-run', command: 'true' },
        ],
      });

      const resumed = resumeMigration(m2, { projectRoot: root });
      expect(resumed.resumedFromIndex).toBe(1);
      expect(resumed.report.overall).toBe('pass');
      expect(resumed.report.steps.length).toBe(3);
      // The rewrite step is carried over (already applied).
      expect(resumed.report.steps[0]!.status).toBe('applied');
      // The previously-failed check now passes.
      expect(resumed.report.steps[1]!.status).toBe('applied');
      // The third step ran for the first time.
      expect(resumed.report.steps[2]!.status).toBe('applied');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resume on a never-run migration runs from the start', () => {
    const root = setup();
    try {
      const m = defineMigration({
        id: 'fresh',
        title: 'Fresh',
        steps: [{ kind: 'shell', command: 'true' }],
      });
      const r = resumeMigration(m, { projectRoot: root });
      expect(r.resumedFromIndex).toBe(0);
      expect(r.report.overall).toBe('pass');
      expect(r.diagnostics.some((d) => d.includes('no saved state'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resume on a fully-complete migration is a no-op', () => {
    const root = setup();
    try {
      const m = defineMigration({
        id: 'done',
        title: 'Done',
        steps: [{ kind: 'shell', command: 'true' }],
      });
      applyMigration(m, { projectRoot: root });
      const r = resumeMigration(m, { projectRoot: root });
      expect(r.report.overall).toBe('pass');
      expect(r.resumedFromIndex).toBe(1);
      expect(r.diagnostics.some((d) => d.includes('already complete'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
