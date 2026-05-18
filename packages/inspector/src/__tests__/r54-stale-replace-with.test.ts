/**
 * `replaceWith` payload in knowledge-stale.
 *
 * Drives `buildKnowledgeStaleReport` directly with a hand-built
 * inspection shape so the test stays focused on the new symbol-
 * relocation detection without paying for full inspect machinery.
 *
 *   - exactly one candidate file → `replaceWith.path` populated.
 *   - multiple candidate files → ambiguous, no `replaceWith`.
 *   - zero candidates → no `replaceWith` (the reference is dropped).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { buildKnowledgeStaleReport } from '../knowledge-stale.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r54-stale-'));
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

/**
 * Minimal inspection shape that `buildKnowledgeStaleReport` actually
 * reads. The function consults `projectRoot`, `knowledgeEntries`,
 * `templates`, `index`, plus a few optional registries. We keep the
 * scope tight.
 */
function makeInspection(
  projectRoot: string,
  entry: import('@shrkcrft/knowledge').IKnowledgeEntry,
): Parameters<typeof buildKnowledgeStaleReport>[0] {
  return {
    projectRoot,
    knowledgeEntries: [entry],
    templates: [],
    pipelines: [],
    index: new Map([[entry.id, entry]]),
    workspace: {
      projectRoot,
      packageJson: { name: 'r54-test' },
    },
    config: null,
    presetRegistry: { list: () => [] },
    pipelineRegistry: { list: () => [] },
    templateRegistry: { list: () => [] },
  } as unknown as Parameters<typeof buildKnowledgeStaleReport>[0];
}

function buildEntryWithSymbolRef(symbol: string, path: string): import('@shrkcrft/knowledge').IKnowledgeEntry {
  return {
    id: 'team.style',
    title: 'Team style',
    type: 'rule',
    priority: 'high',
    scope: [],
    tags: [],
    appliesWhen: [],
    content: 'X.',
    references: [{ kind: 'symbol', symbol, path }],
  } as unknown as import('@shrkcrft/knowledge').IKnowledgeEntry;
}

describe('buildKnowledgeStaleReport replaceWith', () => {
  test('emits replaceWith.path when the symbol has exactly one candidate', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        'packages/new/registry.ts': 'export class MovedThing {}\n',
      });
      const entry = buildEntryWithSymbolRef('MovedThing', 'packages/old/registry.ts');
      const report = buildKnowledgeStaleReport(makeInspection(dir, entry));
      const check = report.referenceChecks[0]!;
      expect(check.replaceWith?.path).toBe('packages/new/registry.ts');
      expect(check.replaceWith?.rationale).toMatch(/MovedThing/);
    });
  });

  test('emits no replaceWith when the symbol has multiple candidates', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        'packages/a/registry.ts': 'export class MovedThing {}\n',
        'packages/b/registry.ts': 'export class MovedThing {}\n',
      });
      const entry = buildEntryWithSymbolRef('MovedThing', 'packages/old/registry.ts');
      const report = buildKnowledgeStaleReport(makeInspection(dir, entry));
      const check = report.referenceChecks[0]!;
      expect(check.replaceWith).toBeUndefined();
    });
  });

  test('emits no replaceWith when the symbol is genuinely gone', () => {
    withTmp((dir) => {
      writeFiles(dir, {
        'packages/other/thing.ts': 'export class SomethingElse {}\n',
      });
      const entry = buildEntryWithSymbolRef('MovedThing', 'packages/old/registry.ts');
      const report = buildKnowledgeStaleReport(makeInspection(dir, entry));
      const check = report.referenceChecks[0]!;
      expect(check.replaceWith).toBeUndefined();
    });
  });
});
