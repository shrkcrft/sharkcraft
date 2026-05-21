import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTemplate } from '@shrkcrft/templates';
import {
  buildSavedPlan,
  evaluatePlannedChange,
  FileChangeType,
  generate,
  isUpdateLike,
  planGeneration,
  SAVED_PLAN_SCHEMA_V1,
  SAVED_PLAN_SCHEMA_V2,
  signPlan,
  verifyPlan,
  type IPlannedOperation,
} from '../index.ts';

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'shrk-v2-test-'));
}

function writeFile(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator — append
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluatePlannedChange — append', () => {
  test('happy path: APPEND with newline separator', () => {
    const out = evaluatePlannedChange({
      change: { targetPath: 'a.ts', operation: { kind: 'append', snippet: 'export const X = 1;\n' } },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: '// header\n',
    });
    expect(out.type).toBe(FileChangeType.Append);
    expect(out.contents).toBe('// header\nexport const X = 1;\n');
    expect(out.operation?.kind).toBe('append');
  });

  test('idempotent: SKIP if snippet already present', () => {
    const out = evaluatePlannedChange({
      change: { targetPath: 'a.ts', operation: { kind: 'append', snippet: 'export const X = 1;\n' } },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: '// header\nexport const X = 1;\n',
    });
    expect(out.type).toBe(FileChangeType.Skip);
  });

  test('idempotent: ifMissing marker', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'append', snippet: '/* new */\n', ifMissing: 'MARKER-1' },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: '// header MARKER-1\n',
    });
    expect(out.type).toBe(FileChangeType.Skip);
  });

  test('CONFLICT if target file missing', () => {
    const out = evaluatePlannedChange({
      change: { targetPath: 'a.ts', operation: { kind: 'append', snippet: 'x' } },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: null,
    });
    expect(out.type).toBe(FileChangeType.Conflict);
  });

  test('inserts \\n separator when existing file has no trailing newline', () => {
    const out = evaluatePlannedChange({
      change: { targetPath: 'a.ts', operation: { kind: 'append', snippet: 'NEW' } },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'TAIL',
    });
    expect(out.contents).toBe('TAIL\nNEW');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator — insert-after / insert-before
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluatePlannedChange — insert-after / insert-before', () => {
  test('insert-after: happy path', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'ROUTE_KEYS.ts',
        operation: { kind: 'insert-after', anchor: 'PAGINATION: \'pagination\',', snippet: '\n  SAMPLE: \'sample\',' },
      },
      absolutePath: '/abs/ROUTE_KEYS.ts',
      relativePath: 'ROUTE_KEYS.ts',
      existing: 'export const ROUTE_KEYS = {\n  PAGINATION: \'pagination\',\n} as const;\n',
    });
    expect(out.type).toBe(FileChangeType.InsertAfter);
    expect(out.contents).toContain('SAMPLE: \'sample\',');
  });

  test('insert-before: happy path', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'ROUTE_KEYS.ts',
        operation: { kind: 'insert-before', anchor: '} as const;', snippet: '  SAMPLE: \'sample\',\n' },
      },
      absolutePath: '/abs/ROUTE_KEYS.ts',
      relativePath: 'ROUTE_KEYS.ts',
      existing: 'export const ROUTE_KEYS = {\n  PAGINATION: \'pagination\',\n} as const;\n',
    });
    expect(out.type).toBe(FileChangeType.InsertBefore);
    expect(out.contents).toContain('SAMPLE: \'sample\',');
  });

  test('CONFLICT when anchor not found', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'insert-after', anchor: 'NOPE', snippet: 'x' },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'no anchor here',
    });
    expect(out.type).toBe(FileChangeType.Conflict);
    expect(out.reason).toContain('anchor not found');
  });

  test('CONFLICT when anchor is ambiguous', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'insert-after', anchor: 'FOO', snippet: 'x' },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'FOO BAR FOO',
    });
    expect(out.type).toBe(FileChangeType.Conflict);
    expect(out.reason).toContain('ambiguous');
  });

  test('idempotent: SKIP when snippet already present', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'insert-after', anchor: 'AFTER', snippet: 'MARKER' },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'AFTER MARKER tail',
    });
    expect(out.type).toBe(FileChangeType.Skip);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator — replace
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluatePlannedChange — replace', () => {
  test('happy path: replaces a single match', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'replace', find: 'OLD', replaceWith: 'NEW' },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'before OLD after',
    });
    expect(out.type).toBe(FileChangeType.Replace);
    expect(out.contents).toBe('before NEW after');
  });

  test('SKIP when already applied (replaceWith present, find absent)', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'replace', find: 'OLD', replaceWith: 'NEW' },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'before NEW after',
    });
    expect(out.type).toBe(FileChangeType.Skip);
  });

  test('CONFLICT when find missing entirely', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'replace', find: 'MISSING', replaceWith: 'X' },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'something else',
    });
    expect(out.type).toBe(FileChangeType.Conflict);
  });

  test('CONFLICT when multiple matches and expectMatches default = 1', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'replace', find: 'X', replaceWith: 'Y' },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'X X X',
    });
    expect(out.type).toBe(FileChangeType.Conflict);
    expect(out.reason).toContain('expected 1');
  });

  test('OK when multiple matches but expectMatches set explicitly', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'a.ts',
        operation: { kind: 'replace', find: 'X', replaceWith: 'Y', expectMatches: 3 },
      },
      absolutePath: '/abs/a.ts',
      relativePath: 'a.ts',
      existing: 'X X X',
    });
    expect(out.type).toBe(FileChangeType.Replace);
    expect(out.contents).toBe('Y Y Y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator — export
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluatePlannedChange — export', () => {
  test('happy path: star export', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'index.ts',
        operation: { kind: 'export', from: './lib/foo' },
      },
      absolutePath: '/abs/index.ts',
      relativePath: 'index.ts',
      existing: 'export * from \'./lib/bar\';\n',
    });
    expect(out.type).toBe(FileChangeType.Export);
    expect(out.contents).toContain("export * from './lib/foo';");
  });

  test('idempotent: SKIP when already exported', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'index.ts',
        operation: { kind: 'export', from: './lib/foo' },
      },
      absolutePath: '/abs/index.ts',
      relativePath: 'index.ts',
      existing: "export * from './lib/foo';\n",
    });
    expect(out.type).toBe(FileChangeType.Skip);
  });

  test('named export form', () => {
    const out = evaluatePlannedChange({
      change: {
        targetPath: 'index.ts',
        operation: { kind: 'export', from: './lib/foo', symbols: ['A', 'B'] },
      },
      absolutePath: '/abs/index.ts',
      relativePath: 'index.ts',
      existing: '\n',
    });
    expect(out.contents).toContain("export { A, B } from './lib/foo';");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Template integration — files() + changes() together
// ─────────────────────────────────────────────────────────────────────────────

describe('planGeneration with changes()', () => {
  test('renders mixed CREATE + APPEND + EXPORT plan', () => {
    const root = makeTmpProject();
    // Pre-existing barrel + keys file (so UPDATE entries have something to touch)
    writeFile(root, 'src/index.ts', "export * from './lib/existing';\n");
    writeFile(root, 'src/keys.ts', 'export const KEYS = {\n} as const;\n');

    const template = defineTemplate({
      id: 'mixed.demo',
      name: 'Mixed v2',
      description: 'create + export + insert-before',
      tags: [],
      scope: [],
      appliesWhen: [],
      variables: [],
      changes: () => [
        { targetPath: 'src/lib/new-thing.ts', operation: { kind: 'create', content: 'export const X = 1;\n' } },
        { targetPath: 'src/index.ts', operation: { kind: 'export', from: './lib/new-thing' } },
        {
          targetPath: 'src/keys.ts',
          operation: { kind: 'insert-before', anchor: '} as const;', snippet: '  NEW: \'new\',\n' },
        },
      ],
    });

    const dry = planGeneration(template, {
      templateId: template.id,
      variables: {},
      projectRoot: root,
    });
    expect(dry.plan.totalFiles).toBe(3);
    expect(dry.plan.changes[0]?.type).toBe(FileChangeType.Create);
    expect(dry.plan.changes[1]?.type).toBe(FileChangeType.Export);
    expect(dry.plan.changes[2]?.type).toBe(FileChangeType.InsertBefore);
    expect(dry.plan.hasConflicts).toBe(false);
    expect(dry.safe).toBe(true);
  });

  test('apply writes CREATE + UPDATE bytes to disk', () => {
    const root = makeTmpProject();
    writeFile(root, 'src/index.ts', "export * from './lib/existing';\n");

    const template = defineTemplate({
      id: 'apply.demo',
      name: 'Apply v2',
      description: '',
      tags: [],
      scope: [],
      appliesWhen: [],
      variables: [],
      changes: () => [
        { targetPath: 'src/lib/new-thing.ts', operation: { kind: 'create', content: 'export const X = 1;\n' } },
        { targetPath: 'src/index.ts', operation: { kind: 'export', from: './lib/new-thing' } },
      ],
    });

    const result = generate(template, {
      templateId: template.id,
      variables: {},
      projectRoot: root,
      write: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary.written).toBe(2);
    }
    const created = readFileSync(join(root, 'src/lib/new-thing.ts'), 'utf8');
    expect(created).toBe('export const X = 1;\n');
    const index = readFileSync(join(root, 'src/index.ts'), 'utf8');
    expect(index).toContain("export * from './lib/new-thing';");
    // Existing line was preserved
    expect(index).toContain("export * from './lib/existing';");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Saved plan v1 vs v2 + signing
// ─────────────────────────────────────────────────────────────────────────────

describe('saved plan schema', () => {
  test('v1 schema emitted for CREATE-only plan', () => {
    const root = makeTmpProject();
    const template = defineTemplate({
      id: 'v1.only',
      name: 'V1',
      description: '',
      tags: [],
      scope: [],
      appliesWhen: [],
      variables: [],
      files: () => [{ targetPath: 'a.ts', content: 'x' }],
    });
    const dry = planGeneration(template, {
      templateId: template.id,
      variables: {},
      projectRoot: root,
    });
    const saved = buildSavedPlan({
      templateId: template.id,
      variables: {},
      projectRoot: root,
      plan: dry.plan,
    });
    expect(saved.schema).toBe(SAVED_PLAN_SCHEMA_V1);
    expect(saved.expectedChanges?.[0]?.operation).toBeUndefined();
  });

  test('v2 schema emitted when any change has an operation', () => {
    const root = makeTmpProject();
    writeFile(root, 'a.ts', 'tail\n');
    const template = defineTemplate({
      id: 'v2.append',
      name: 'V2',
      description: '',
      tags: [],
      scope: [],
      appliesWhen: [],
      variables: [],
      changes: () => [{ targetPath: 'a.ts', operation: { kind: 'append', snippet: 'EXTRA\n' } }],
    });
    const dry = planGeneration(template, {
      templateId: template.id,
      variables: {},
      projectRoot: root,
    });
    const saved = buildSavedPlan({
      templateId: template.id,
      variables: {},
      projectRoot: root,
      plan: dry.plan,
    });
    expect(saved.schema).toBe(SAVED_PLAN_SCHEMA_V2);
    expect(saved.expectedChanges?.[0]?.operation?.kind).toBe('append');
  });
});

describe('plan signing covers v2 operation', () => {
  test('tampering with operation.snippet invalidates the signature', () => {
    const root = makeTmpProject();
    writeFile(root, 'a.ts', 'tail\n');
    const template = defineTemplate({
      id: 'v2.sig',
      name: 'V2 sig',
      description: '',
      tags: [],
      scope: [],
      appliesWhen: [],
      variables: [],
      changes: () => [{ targetPath: 'a.ts', operation: { kind: 'append', snippet: 'GOOD\n' } }],
    });
    const dry = planGeneration(template, {
      templateId: template.id,
      variables: {},
      projectRoot: root,
    });
    const saved = buildSavedPlan({
      templateId: template.id,
      variables: {},
      projectRoot: root,
      plan: dry.plan,
    });
    const signed = signPlan(saved, { secret: 'test-secret' });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;

    // Tamper with the operation snippet
    const tampered = JSON.parse(JSON.stringify(signed.value));
    (tampered.expectedChanges[0].operation as IPlannedOperation & { snippet: string }).snippet =
      'EVIL\n';
    const verify = verifyPlan(tampered, { secret: 'test-secret' });
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.status).toBe('invalid-signature');
  });

  test('untampered v2 plan verifies', () => {
    const root = makeTmpProject();
    writeFile(root, 'a.ts', 'tail\n');
    const template = defineTemplate({
      id: 'v2.ok',
      name: 'V2 ok',
      description: '',
      tags: [],
      scope: [],
      appliesWhen: [],
      variables: [],
      changes: () => [{ targetPath: 'a.ts', operation: { kind: 'append', snippet: 'OK\n' } }],
    });
    const dry = planGeneration(template, {
      templateId: template.id,
      variables: {},
      projectRoot: root,
    });
    const saved = buildSavedPlan({
      templateId: template.id,
      variables: {},
      projectRoot: root,
      plan: dry.plan,
    });
    const signed = signPlan(saved, { secret: 'test-secret' });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const verify = verifyPlan(signed.value, { secret: 'test-secret' });
    expect(verify.ok).toBe(true);
  });
});

describe('isUpdateLike', () => {
  test('classifies kinds correctly', () => {
    expect(isUpdateLike(FileChangeType.Append)).toBe(true);
    expect(isUpdateLike(FileChangeType.InsertAfter)).toBe(true);
    expect(isUpdateLike(FileChangeType.InsertBefore)).toBe(true);
    expect(isUpdateLike(FileChangeType.Replace)).toBe(true);
    expect(isUpdateLike(FileChangeType.Export)).toBe(true);
    expect(isUpdateLike(FileChangeType.Create)).toBe(false);
    expect(isUpdateLike(FileChangeType.Skip)).toBe(false);
    expect(isUpdateLike(FileChangeType.Conflict)).toBe(false);
    expect(isUpdateLike(FileChangeType.Update)).toBe(false);
  });
});
