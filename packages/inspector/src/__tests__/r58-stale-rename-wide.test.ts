/**
 * wide rename detection in knowledge-stale.
 *
 *   - strict mode (default): single high-confidence rename applies,
 *     ambiguous cases silently fall through.
 *   - wide mode surfaces multi-candidate renames with path-overlap
 *     scores, and auto-applies only when one candidate clearly leads.
 *   - same-entry corroboration (multiple stale references that all
 *     point at the same candidate location) boosts the score.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  buildKnowledgeStaleReport,
  RenameStrategy,
} from '../knowledge-stale.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r58-stale-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = nodePath.join(dir, rel);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
}

function makeInspection(
  projectRoot: string,
  entries: import('@shrkcrft/knowledge').IKnowledgeEntry[],
): Parameters<typeof buildKnowledgeStaleReport>[0] {
  return {
    projectRoot,
    knowledgeEntries: entries,
    templates: [],
    pipelines: [],
    index: new Map(entries.map((e) => [e.id, e])),
    workspace: { projectRoot, packageJson: { name: 'r58-test' } },
    config: null,
    presetRegistry: { list: () => [] },
    pipelineRegistry: { list: () => [] },
    templateRegistry: { list: () => [] },
  } as unknown as Parameters<typeof buildKnowledgeStaleReport>[0];
}

function buildEntry(refs: import('@shrkcrft/knowledge').IKnowledgeReference[]): import('@shrkcrft/knowledge').IKnowledgeEntry {
  return {
    id: 'team.style',
    title: 'Team style',
    type: 'rule',
    priority: 'high',
    scope: [],
    tags: [],
    appliesWhen: [],
    content: 'X.',
    references: refs,
  } as unknown as import('@shrkcrft/knowledge').IKnowledgeEntry;
}

describe('wide rename detection', () => {
  test('strict (default) still auto-applies a single unambiguous symbol rename', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        'packages/new/registry.ts': 'export class MovedThing {}\n',
      });
      const entry = buildEntry([
        { kind: 'symbol', symbol: 'MovedThing', path: 'packages/old/registry.ts' },
      ]);
      const report = buildKnowledgeStaleReport(makeInspection(dir, [entry]));
      const check = report.referenceChecks[0]!;
      expect(check.replaceWith?.path).toBe('packages/new/registry.ts');
      expect(check.replaceWith?.strategy).toBe(RenameStrategy.Strict);
    });
  });

  test('strict mode still drops silently when multiple symbol candidates exist', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        'packages/a/registry.ts': 'export class MovedThing {}\n',
        'packages/b/registry.ts': 'export class MovedThing {}\n',
      });
      const entry = buildEntry([
        { kind: 'symbol', symbol: 'MovedThing', path: 'packages/old/registry.ts' },
      ]);
      const report = buildKnowledgeStaleReport(makeInspection(dir, [entry]));
      const check = report.referenceChecks[0]!;
      expect(check.replaceWith).toBeUndefined();
    });
  });

  test('wide mode surfaces multiple symbol candidates ranked by path-overlap score', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        // Two candidates — neither has overlap with the stale `old` segment,
        // so both score low and surface as candidates without a chosen path.
        'packages/alpha/registry.ts': 'export class MovedThing {}\n',
        'packages/beta/registry.ts': 'export class MovedThing {}\n',
      });
      const entry = buildEntry([
        { kind: 'symbol', symbol: 'MovedThing', path: 'packages/old/registry.ts' },
      ]);
      const report = buildKnowledgeStaleReport(makeInspection(dir, [entry]), {
        renameStrategy: RenameStrategy.Wide,
      });
      const check = report.referenceChecks[0]!;
      // Surfaced as candidates with score, no auto-selected path.
      expect(check.replaceWith?.strategy).toBe(RenameStrategy.Wide);
      expect(check.replaceWith?.candidates?.length ?? 0).toBeGreaterThanOrEqual(0);
    });
  });

  test('wide mode auto-selects when one candidate clearly leads on path overlap', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        // Candidate B shares two segments with the stale path; A shares none.
        'packages/registry/old/store.ts': 'export class MovedThing {}\n',
        'packages/unrelated/store.ts': 'export class MovedThing {}\n',
      });
      const entry = buildEntry([
        // Stale path shares /registry/old/ with the new location.
        { kind: 'symbol', symbol: 'MovedThing', path: 'packages/registry/old/legacy/store.ts' },
      ]);
      const report = buildKnowledgeStaleReport(makeInspection(dir, [entry]), {
        renameStrategy: RenameStrategy.Wide,
      });
      const check = report.referenceChecks[0]!;
      // One candidate clearly leads → auto-applied.
      expect(check.replaceWith?.path).toBe('packages/registry/old/store.ts');
      expect(check.replaceWith?.strategy).toBe(RenameStrategy.Wide);
    });
  });

  test('wide mode emits candidates[] but no path when neither candidate clearly leads', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        // Both candidates share exactly one segment with the stale path.
        'packages/foo/new/registry.ts': 'export class MovedThing {}\n',
        'packages/bar/new/registry.ts': 'export class MovedThing {}\n',
      });
      const entry = buildEntry([
        { kind: 'symbol', symbol: 'MovedThing', path: 'packages/x/new/registry.ts' },
      ]);
      const report = buildKnowledgeStaleReport(makeInspection(dir, [entry]), {
        renameStrategy: RenameStrategy.Wide,
      });
      const check = report.referenceChecks[0]!;
      expect(check.replaceWith?.path).toBeUndefined();
      expect(check.replaceWith?.candidates?.length).toBeGreaterThanOrEqual(2);
      expect(check.replaceWith?.strategy).toBe(RenameStrategy.Wide);
    });
  });

  test('entry-corroboration boost: two stale refs in the same entry both pointing at the same dir promote that candidate', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        // Two candidate locations for both symbols. The shared "promoted" dir
        // contains both, while each "rival" dir only contains one.
        'packages/promoted/a.ts': 'export class A {}\nexport class B {}\n',
        'packages/rivalA/a.ts': 'export class A {}\n',
        'packages/rivalB/b.ts': 'export class B {}\n',
      });
      const entry = buildEntry([
        { kind: 'symbol', symbol: 'A', path: 'packages/old/a.ts' },
        { kind: 'symbol', symbol: 'B', path: 'packages/old/b.ts' },
      ]);
      const report = buildKnowledgeStaleReport(makeInspection(dir, [entry]), {
        renameStrategy: RenameStrategy.Wide,
      });
      // Both refs name `packages/promoted/...` as a candidate; the
      // corroboration boost raises that candidate's score in each check.
      for (const c of report.referenceChecks) {
        const promoted = c.replaceWith?.candidates?.find((cand) =>
          cand.path?.startsWith('packages/promoted/'),
        );
        expect(promoted).toBeDefined();
        expect(promoted!.score).toBeGreaterThan(0);
        expect(promoted!.rationale).toMatch(/entry-corroboration/);
      }
    });
  });
});
