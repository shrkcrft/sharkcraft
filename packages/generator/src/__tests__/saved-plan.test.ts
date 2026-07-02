import { describe, expect, test } from "bun:test";
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSavedPlan,
  diffPlanChanges,
  type IGenerationPlan,
  readPlanFromFile,
  SAVED_PLAN_SCHEMA,
  savePlanToFile,
  sha256Hex,
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

describe('buildSavedPlan — persisted body + digest', () => {
  test('embeds the rendered body and a matching sha256 per entry', () => {
    const saved = buildSavedPlan({
      templateId: 'typescript.service',
      name: 'user-profile',
      variables: { className: 'UserProfileService' },
      projectRoot: '/abs',
      plan: examplePlan,
    });
    const entry = saved.expectedChanges?.[0];
    expect(entry).toBeDefined();
    // Body is byte-identical to the rendered content (what `--print` shows).
    expect(entry?.body).toBe(examplePlan.changes[0]!.contents);
    // Digest is present and matches the body.
    expect(typeof entry?.sha256).toBe('string');
    expect(entry?.sha256).toHaveLength(64);
    const independentDigest = createHash('sha256')
      .update(examplePlan.changes[0]!.contents, 'utf8')
      .digest('hex');
    expect(entry?.sha256).toBe(independentDigest);
    expect(entry?.sha256).toBe(sha256Hex(entry!.body!));
    // sizeBytes is retained (backward-compatible, additive fields only).
    expect(entry?.sizeBytes).toBe(examplePlan.changes[0]!.sizeBytes);
  });

  test('body + digest survive a save/read round-trip on disk', () => {
    const root = makeTmp();
    const path = join(root, 'plan.json');
    const saved = buildSavedPlan({
      templateId: 'typescript.service',
      variables: {},
      projectRoot: root,
      plan: examplePlan,
    });
    savePlanToFile(saved, path);
    const read = readPlanFromFile(path);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const entry = read.value.expectedChanges?.[0];
      expect(entry?.body).toBe(examplePlan.changes[0]!.contents);
      expect(entry?.sha256).toBe(sha256Hex(entry!.body!));
    }
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

  test('reports content-changed when body differs at the same byte count', () => {
    const saved = buildSavedPlan({
      templateId: 't',
      variables: {},
      projectRoot: '/x',
      plan: examplePlan,
    });
    const original = examplePlan.changes[0]!.contents;
    // Same length, different bytes — a size check alone would miss this.
    const swapped = original.replace('UserProfileService', 'UserProfileServvce');
    expect(swapped.length).toBe(original.length);
    const mutated = {
      ...examplePlan.changes[0]!,
      contents: swapped,
      sizeBytes: examplePlan.changes[0]!.sizeBytes,
    };
    const diff = diffPlanChanges(saved, { ...examplePlan, changes: [mutated] });
    expect(diff[0]?.kind).toBe('content-changed');
  });
});
