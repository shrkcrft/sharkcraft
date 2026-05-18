import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSavedPlan,
  diffPlanChanges,
  type IGenerationPlan,
  readPlanFromFile,
  SAVED_PLAN_SCHEMA,
  savePlanToFile
} from '../index.ts';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'shrk-plan-test-'));
}

const examplePlan: IGenerationPlan = {
  templateId: 'typescript.service',
  templateName: 'TS Service',
  changes: [
    {
      type: 'create' as never,
      absolutePath: '/abs/src/services/user-profile.service.ts',
      relativePath: 'src/services/user-profile.service.ts',
      contents: 'export class UserProfileService {}\n',
      reason: 'New file',
      sizeBytes: 35,
    },
  ],
  totalFiles: 1,
  hasConflicts: false,
  warnings: [],
  postGenerationNotes: ['Add tests.'],
};

describe('buildSavedPlan', () => {
  test('produces a plan with the v1 schema marker', () => {
    const saved = buildSavedPlan({
      templateId: 'typescript.service',
      name: 'user-profile',
      variables: { className: 'UserProfileService' },
      projectRoot: '/abs',
      plan: examplePlan,
    });
    expect(saved.schema).toBe(SAVED_PLAN_SCHEMA);
    expect(saved.templateId).toBe('typescript.service');
    expect(saved.name).toBe('user-profile');
    expect(saved.variables).toEqual({ className: 'UserProfileService' });
    expect(saved.expectedChanges?.[0]?.relativePath).toBe(
      'src/services/user-profile.service.ts',
    );
  });
});

describe('savePlanToFile / readPlanFromFile', () => {
  test('round-trips', () => {
    const root = makeTmp();
    const path = join(root, 'plan.json');
    const saved = buildSavedPlan({
      templateId: 'typescript.service',
      name: 'user-profile',
      variables: { className: 'UserProfileService' },
      projectRoot: root,
      plan: examplePlan,
    });
    const writeResult = savePlanToFile(saved, path);
    expect(writeResult.ok).toBe(true);
    const readResult = readPlanFromFile(path);
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.templateId).toBe('typescript.service');
    }
  });

  test('returns NOT_FOUND for missing plan', () => {
    const result = readPlanFromFile('/nope/missing.json');
    expect(result.ok).toBe(false);
  });

  test('rejects non-JSON files', () => {
    const root = makeTmp();
    const path = join(root, 'bad.json');
    writeFileSync(path, 'not json at all', 'utf8');
    const result = readPlanFromFile(path);
    expect(result.ok).toBe(false);
  });

  test('rejects wrong schema', () => {
    const root = makeTmp();
    const path = join(root, 'wrong.json');
    writeFileSync(path, JSON.stringify({ schema: 'unknown/v0', templateId: 'x' }), 'utf8');
    const result = readPlanFromFile(path);
    expect(result.ok).toBe(false);
  });

  test('rejects non-string variable value', () => {
    const root = makeTmp();
    const path = join(root, 'bad-vars.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema: SAVED_PLAN_SCHEMA,
        templateId: 'x',
        variables: { num: 42 },
        projectRoot: '/x',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      'utf8',
    );
    const result = readPlanFromFile(path);
    expect(result.ok).toBe(false);
  });
});

describe('diffPlanChanges', () => {
  test('returns empty when expected matches actual', () => {
    const saved = buildSavedPlan({
      templateId: 't',
      variables: {},
      projectRoot: '/x',
      plan: examplePlan,
    });
    expect(diffPlanChanges(saved, examplePlan).length).toBe(0);
  });

  test('reports added file', () => {
    const saved = buildSavedPlan({
      templateId: 't',
      variables: {},
      projectRoot: '/x',
      plan: { ...examplePlan, changes: [], totalFiles: 0 },
    });
    const diff = diffPlanChanges(saved, examplePlan);
    expect(diff.length).toBe(1);
    expect(diff[0]?.kind).toBe('added');
  });

  test('reports size-changed file', () => {
    const saved = buildSavedPlan({
      templateId: 't',
      variables: {},
      projectRoot: '/x',
      plan: examplePlan,
    });
    const bigger = { ...examplePlan.changes[0]!, sizeBytes: 999 };
    const diff = diffPlanChanges(saved, { ...examplePlan, changes: [bigger] });
    expect(diff[0]?.kind).toBe('size-changed');
  });
});
