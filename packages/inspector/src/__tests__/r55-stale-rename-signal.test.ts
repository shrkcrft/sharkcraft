/**
 * knowledge-stale file/directory rename signal.
 *
 * The heuristic covers symbol references with a unique file match,
 * file-path references (the common case: a directory was renamed),
 * and directory references.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  buildKnowledgeStaleReport,
  ReferenceCheckOutcome,
} from '../knowledge-stale.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r55-rename-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeInspection(
  root: string,
  references: ReadonlyArray<Record<string, unknown>>,
): ISharkcraftInspection {
  // Minimal inspection shape — buildKnowledgeStaleReport only uses
  // `projectRoot`, `knowledgeEntries`, and indirectly the file system.
  return {
    projectRoot: root,
    knowledgeEntries: [
      {
        id: 'k.test',
        title: 'k',
        type: 'rule',
        priority: 'low',
        content: 'x',
        references,
      } as unknown,
    ],
  } as unknown as ISharkcraftInspection;
}

describe('knowledge-stale rename signal', () => {
  test('emits replaceWith for a file moved to a new directory (unique match)', () => {
    withRoot((root) => {
      mkdirSync(nodePath.join(root, 'packages/x/src/new'), { recursive: true });
      writeFileSync(
        nodePath.join(root, 'packages/x/src/new/util.ts'),
        'export const x = 1;\n',
      );
      const inspection = fakeInspection(root, [
        {
          kind: 'file',
          path: 'packages/x/src/old/util.ts',
          required: false,
        },
      ]);
      const report = buildKnowledgeStaleReport(inspection);
      const check = report.referenceChecks[0]!;
      expect(check.outcome).toBe(ReferenceCheckOutcome.Stale);
      expect(check.replaceWith?.path).toBe('packages/x/src/new/util.ts');
    });
  });

  test('declines when two candidates share the basename (ambiguous)', () => {
    withRoot((root) => {
      mkdirSync(nodePath.join(root, 'packages/a/src/sub'), { recursive: true });
      mkdirSync(nodePath.join(root, 'packages/b/src/sub'), { recursive: true });
      writeFileSync(nodePath.join(root, 'packages/a/src/sub/util.ts'), 'x');
      writeFileSync(nodePath.join(root, 'packages/b/src/sub/util.ts'), 'x');
      const inspection = fakeInspection(root, [
        {
          kind: 'file',
          path: 'packages/c/src/sub/util.ts',
          required: false,
        },
      ]);
      const report = buildKnowledgeStaleReport(inspection);
      const check = report.referenceChecks[0]!;
      expect(check.outcome).toBe(ReferenceCheckOutcome.Stale);
      expect(check.replaceWith).toBeUndefined();
    });
  });

  test('declines when the basename match shares no parent segment (namesake)', () => {
    withRoot((root) => {
      mkdirSync(nodePath.join(root, 'packages/unrelated/totally/different'), {
        recursive: true,
      });
      writeFileSync(
        nodePath.join(root, 'packages/unrelated/totally/different/util.ts'),
        'x',
      );
      const inspection = fakeInspection(root, [
        {
          kind: 'file',
          path: 'sharkcraft/old/util.ts',
          required: false,
        },
      ]);
      const report = buildKnowledgeStaleReport(inspection);
      const check = report.referenceChecks[0]!;
      expect(check.outcome).toBe(ReferenceCheckOutcome.Stale);
      // No overlap → no replaceWith.
      expect(check.replaceWith).toBeUndefined();
    });
  });

  test('emits replaceWith for a directory moved to a new parent', () => {
    withRoot((root) => {
      mkdirSync(nodePath.join(root, 'packages/x/src/new/inner'), {
        recursive: true,
      });
      writeFileSync(
        nodePath.join(root, 'packages/x/src/new/inner/util.ts'),
        'x',
      );
      const inspection = fakeInspection(root, [
        {
          kind: 'directory',
          path: 'packages/x/src/old/inner',
        },
      ]);
      const report = buildKnowledgeStaleReport(inspection);
      const check = report.referenceChecks[0]!;
      expect(check.outcome).toBe(ReferenceCheckOutcome.Stale);
      expect(check.replaceWith?.path).toBe('packages/x/src/new/inner');
    });
  });
});
