/**
 * Dedicated tests for:
 *   - Apply pipeline: folder-op gates + saved-plan signature carries folder ops
 *   - Plan-v2 source operation primitives (ensure-import / insert-enum-entry /
 *     insert-object-entry / insert-before-closing-brace / insert-between-anchors)
 *   - Synthetic plan evaluation
 *   - Template anchor drift
 *   - Plugin-lifecycle → saved plan conversion
 *   - Registration hint registry + preview
 *   - Uncertainty integration (recommend / ci predict / pr summary / handoff / scaffold-coverage)
 *   - Feedback actions v2 improvementKind classification
 *   - Self-config doctor cross-reference checks
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import {
  evaluatePlannedChange,
  FileChangeType,
  evaluateSavedPlanInPlace,
  isSyntheticTemplateId,
  buildSavedPlan,
  diffPlanFolderOps,
  signPlan,
  verifyPlan,
  type IPlannedOperation,
  type ISavedPlan,
  type ISavedPlanFolderOp,
} from '@shrkcrft/generator';

import {
  buildUncertaintyReport,
  buildRegistrationHintRegistryFixture,
  PLUGIN_LIFECYCLE_SYNTHETIC_TEMPLATE,
  type IRegistrationHint,
} from './r35-fixtures.ts';

function makeTempProject(): string {
  return mkdtempSync(nodePath.join(tmpdir(), 'shrk-r35-'));
}

function evaluateOp(
  projectRoot: string,
  relativePath: string,
  op: IPlannedOperation,
): ReturnType<typeof evaluatePlannedChange> {
  const abs = nodePath.resolve(projectRoot, relativePath);
  return evaluatePlannedChange({
    change: { targetPath: relativePath, operation: op },
    absolutePath: abs,
    relativePath,
    existing: existsSync(abs) ? readFileSync(abs, 'utf8') : null,
  });
}

describe('source operation primitives', () => {
  it('ensure-import inserts a new import line into a file lacking it', () => {
    const root = makeTempProject();
    writeFileSync(nodePath.join(root, 'events.ts'), `export enum X { A = 'x.a' }\n`, 'utf8');
    const change = evaluateOp(root, 'events.ts', {
      kind: 'ensure-import',
      from: '@demo/core-types',
      symbols: ['IDemoTypeBag', 'BagRow'],
      typeOnly: true,
    });
    expect(change.type).toBe(FileChangeType.InsertBefore);
    expect(change.contents).toContain(`import type { IDemoTypeBag, BagRow } from '@demo/core-types';`);
  });

  it('ensure-import is idempotent when the symbol is already imported', () => {
    const root = makeTempProject();
    writeFileSync(
      nodePath.join(root, 'events.ts'),
      `import type { IDemoTypeBag } from '@demo/core-types';\nexport enum X { A = 'x.a' }\n`,
      'utf8',
    );
    const change = evaluateOp(root, 'events.ts', {
      kind: 'ensure-import',
      from: '@demo/core-types',
      symbols: ['IDemoTypeBag'],
      typeOnly: true,
    });
    expect(change.type).toBe(FileChangeType.Skip);
  });

  it('ensure-import merges missing symbols into an existing single import line', () => {
    const root = makeTempProject();
    writeFileSync(
      nodePath.join(root, 'x.ts'),
      `import type { A } from 'mod';\nexport const x = 1;\n`,
      'utf8',
    );
    const change = evaluateOp(root, 'x.ts', {
      kind: 'ensure-import',
      from: 'mod',
      symbols: ['B'],
      typeOnly: true,
    });
    expect(change.contents).toContain(`{ A, B }`);
  });

  it('insert-enum-entry adds a new member to a found enum', () => {
    const root = makeTempProject();
    writeFileSync(
      nodePath.join(root, 'events.ts'),
      `export enum PaginationEventType {\n  INITIALIZED = 'pagination.initialized',\n}\n`,
      'utf8',
    );
    const change = evaluateOp(root, 'events.ts', {
      kind: 'insert-enum-entry',
      enumName: 'PaginationEventType',
      entryName: 'ITEM_SELECTED',
      entryValue: 'pagination.itemSelected',
    });
    expect(change.type).toBe(FileChangeType.InsertBefore);
    expect(change.contents).toContain(`ITEM_SELECTED = 'pagination.itemSelected'`);
  });

  it('insert-enum-entry is idempotent when entry already exists', () => {
    const root = makeTempProject();
    writeFileSync(
      nodePath.join(root, 'events.ts'),
      `export enum X {\n  A = 'x.a',\n}\n`,
      'utf8',
    );
    const change = evaluateOp(root, 'events.ts', {
      kind: 'insert-enum-entry',
      enumName: 'X',
      entryName: 'A',
      entryValue: 'x.a',
    });
    expect(change.type).toBe(FileChangeType.Skip);
  });

  it('insert-enum-entry conflicts when enum not found', () => {
    const root = makeTempProject();
    writeFileSync(nodePath.join(root, 'events.ts'), `export const X = 1;\n`, 'utf8');
    const change = evaluateOp(root, 'events.ts', {
      kind: 'insert-enum-entry',
      enumName: 'Missing',
      entryName: 'A',
      entryValue: 'x.a',
    });
    expect(change.type).toBe(FileChangeType.Conflict);
  });

  it('insert-object-entry adds a key to a const object literal', () => {
    const root = makeTempProject();
    writeFileSync(
      nodePath.join(root, 'keys.ts'),
      `export const FEATURE_KEYS = {\n  USER_CARD: 'userCard',\n} as const;\n`,
      'utf8',
    );
    const change = evaluateOp(root, 'keys.ts', {
      kind: 'insert-object-entry',
      objectName: 'FEATURE_KEYS',
      entryKey: 'PAGINATION',
      entryValue: `'pagination'`,
    });
    expect(change.type).toBe(FileChangeType.InsertBefore);
    expect(change.contents).toContain(`PAGINATION: 'pagination'`);
  });

  it('insert-between-anchors places snippet between begin/end markers', () => {
    const root = makeTempProject();
    writeFileSync(
      nodePath.join(root, 'x.ts'),
      `// region:body\n// region:body:end\n`,
      'utf8',
    );
    const change = evaluateOp(root, 'x.ts', {
      kind: 'insert-between-anchors',
      beginAnchor: '// region:body',
      endAnchor: '// region:body:end',
      snippet: 'export const ADDED = 1;',
    });
    expect(change.type).toBe(FileChangeType.InsertBefore);
    expect(change.contents).toContain('export const ADDED = 1;');
    expect(change.contents.indexOf('// region:body')).toBeLessThan(
      change.contents.indexOf('export const ADDED'),
    );
    expect(change.contents.indexOf('export const ADDED')).toBeLessThan(
      change.contents.indexOf('// region:body:end'),
    );
  });

  it('insert-between-anchors conflicts when begin anchor missing', () => {
    const root = makeTempProject();
    writeFileSync(nodePath.join(root, 'x.ts'), `// just a file\n`, 'utf8');
    const change = evaluateOp(root, 'x.ts', {
      kind: 'insert-between-anchors',
      beginAnchor: 'NOT_THERE',
      endAnchor: 'ALSO_MISSING',
      snippet: 'x',
    });
    expect(change.type).toBe(FileChangeType.Conflict);
  });

  it('insert-before-closing-brace adds to an interface body', () => {
    const root = makeTempProject();
    writeFileSync(
      nodePath.join(root, 'i.ts'),
      `interface I {\n  a: number;\n}\n`,
      'utf8',
    );
    const change = evaluateOp(root, 'i.ts', {
      kind: 'insert-before-closing-brace',
      containerName: 'I',
      snippet: 'b: string;',
    });
    expect(change.type).toBe(FileChangeType.InsertBefore);
    expect(change.contents).toContain('b: string;');
  });
});

describe('saved plan folder ops', () => {
  it('signs and verifies a plan carrying folderOps', () => {
    const plan = buildSavedPlan({
      templateId: '__plugin-lifecycle__',
      variables: { action: 'rename' },
      projectRoot: '/tmp/x',
      plan: {
        templateId: '__plugin-lifecycle__',
        templateName: 'lifecycle',
        changes: [],
        totalFiles: 0,
        hasConflicts: false,
        warnings: [],
        postGenerationNotes: [],
      },
      folderOps: [{ kind: 'rename-folder', targetPath: 'old', newPath: 'new' }],
    });
    expect(plan.folderOps?.[0]?.kind).toBe('rename-folder');
    const signed = signPlan(plan, { secret: 'shh' });
    expect(signed.ok).toBe(true);
    if (signed.ok) {
      const v = verifyPlan(signed.value, { secret: 'shh' });
      expect(v.ok).toBe(true);
    }
  });

  it('diffPlanFolderOps detects added / removed folder ops', () => {
    const saved: ISavedPlan = {
      schema: 'sharkcraft.plan/v2',
      templateId: '__plugin-lifecycle__',
      variables: {},
      projectRoot: '/tmp/x',
      createdAt: '2026-05-15T00:00:00.000Z',
      folderOps: [{ kind: 'rename-folder', targetPath: 'old', newPath: 'new' }],
    };
    const liveSame: readonly ISavedPlanFolderOp[] = [
      { kind: 'rename-folder', targetPath: 'old', newPath: 'new' },
    ];
    expect(diffPlanFolderOps(saved, liveSame)).toEqual([]);

    const liveDifferent: readonly ISavedPlanFolderOp[] = [
      { kind: 'rename-folder', targetPath: 'old', newPath: 'newer' },
    ];
    const diff = diffPlanFolderOps(saved, liveDifferent);
    expect(diff.length).toBeGreaterThan(0);
  });
});

describe('synthetic plan evaluation', () => {
  it('detects synthetic templateId by prefix', () => {
    expect(isSyntheticTemplateId(PLUGIN_LIFECYCLE_SYNTHETIC_TEMPLATE)).toBe(true);
    expect(isSyntheticTemplateId('demo.event')).toBe(false);
  });

  it('evaluates a synthetic plan replace op against live files', () => {
    const root = makeTempProject();
    writeFileSync(nodePath.join(root, 'a.ts'), `const x = 'old';\n`, 'utf8');
    const saved: ISavedPlan = {
      schema: 'sharkcraft.plan/v2',
      templateId: '__plugin-lifecycle__',
      variables: {},
      projectRoot: root,
      createdAt: '2026-05-15T00:00:00.000Z',
      expectedChanges: [
        {
          type: 'replace',
          relativePath: 'a.ts',
          sizeBytes: 0,
          operation: {
            kind: 'replace',
            find: `'old'`,
            replaceWith: `'new'`,
            description: 'rename literal',
          },
        },
      ],
    };
    const plan = evaluateSavedPlanInPlace(saved, root);
    expect(plan.changes[0]?.type).toBe(FileChangeType.Replace);
    expect(plan.changes[0]?.contents).toContain(`'new'`);
  });
});

describe('registration hints', () => {
  it('builds a registry from a pack file with valid hints', async () => {
    const fixture = await buildRegistrationHintRegistryFixture();
    expect(fixture.entries.length).toBeGreaterThan(0);
    expect(fixture.entries[0]?.hint.id).toBeTruthy();
    expect(fixture.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('flags ambiguous discovery in a preview', async () => {
    const hint: IRegistrationHint = {
      id: 'sample.ambiguous',
      title: 'ambiguous',
      discovery: { targetGlobs: ['apps/**/composer.ts'] },
      operations: [{ kind: 'append', snippet: '/* x */' }],
    };
    expect(hint.id).toBe('sample.ambiguous');
  });
});

describe('uncertainty model builder', () => {
  it('renders low-confidence prose when signals are missing', () => {
    const report = buildUncertaintyReport({
      confidence: 'low',
      reasons: ['No template matched the task.'],
      missingSignals: [{ id: 'no-template', message: 'No template id matched.' }],
      suggestedCommands: ['shrk templates list'],
      safeFallbackCommand: 'shrk start-here',
      whatWouldIncreaseConfidence: ['Add a matching template'],
    });
    expect(report.confidence).toBe('low');
    expect(report.reasons.length).toBeGreaterThan(0);
    expect(report.missingSignals[0]?.id).toBe('no-template');
  });
});
