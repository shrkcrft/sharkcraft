/**
 * Round 11 §3.2#4 — a misspelled planned operation becomes a LOCATED conflict,
 * never an unlocated TypeError (`undefined is not an object (evaluating
 * 'marker.length')`), and an extra key is a warning, never a silent drop.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ITemplateDefinition } from '@shrkcrft/templates';
import { FileChangeType, PLANNED_OPERATION_FIELDS, planGeneration, validatePlannedOperation } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-ops-'));
  roots.push(root);
  writeFileSync(join(root, 'registry.ts'), 'export const ALL = [\n  "a",\n];\nexport const MAP = {\n  a: 1,\n};\n');
  return root;
}

function template(operation: Record<string, unknown>): ITemplateDefinition {
  return {
    id: 'reg.add',
    name: 'Register',
    description: 'd',
    tags: [],
    scope: [],
    appliesWhen: [],
    variables: [{ name: 'name', required: true }],
    changes: () => [{ targetPath: 'registry.ts', operation } as never],
  };
}

describe('planGeneration — operation shape', () => {
  const misspelled: readonly [string, Record<string, unknown>, string][] = [
    ['append', { kind: 'append', key: 'k', value: 'v' }, 'snippet'],
    ['insert-object-entry', { kind: 'insert-object-entry', objectName: 'MAP', key: 'b', value: '2' }, 'entryKey'],
    ['insert-array-entry', { kind: 'insert-array-entry', arrayName: 'ALL', key: 'b', value: '"b"' }, 'entryValue'],
  ];
  for (const [label, op, missingField] of misspelled) {
    test(`${label} with key/value → a Conflict naming the change index, the missing and the unknown keys`, () => {
      const r = planGeneration(template(op), { templateId: 'reg.add', name: 'b', variables: { name: 'b' }, projectRoot: project() });
      expect(r.safe).toBe(false);
      const conflict = r.plan.changes.find((c) => c.type === FileChangeType.Conflict);
      expect(conflict?.reason).toContain("template 'reg.add' change[0]");
      expect(conflict?.reason).toContain(missingField);
      expect(conflict?.reason).toContain('unknown keys');
      expect(conflict?.reason).toContain('did you mean');
    });
  }

  test('an unknown kind is a Conflict, never a throw', () => {
    const r = planGeneration(template({ kind: 'prepend', snippet: 'x' }), {
      templateId: 'reg.add',
      name: 'b',
      variables: { name: 'b' },
      projectRoot: project(),
    });
    expect(r.plan.changes[0]!.type).toBe(FileChangeType.Conflict);
    expect(r.plan.changes[0]!.reason).toContain('unknown operation kind "prepend"');
  });

  test('extra keys with every required field present → a plan WARNING, not a conflict', () => {
    const r = planGeneration(
      template({ kind: 'insert-array-entry', arrayName: 'ALL', entryValue: '"b"', bogusExtra: 1 }),
      { templateId: 'reg.add', name: 'b', variables: { name: 'b' }, projectRoot: project() },
    );
    expect(r.plan.changes.some((c) => c.type === FileChangeType.Conflict)).toBe(false);
    expect(r.plan.warnings.join('\n')).toContain('bogusExtra');
  });
});

describe('PLANNED_OPERATION_FIELDS — one row per operation kind', () => {
  test('every IPlannedOperation kind has a table row (and nothing else does)', () => {
    expect(Object.keys(PLANNED_OPERATION_FIELDS).sort()).toEqual(
      [
        'append',
        'create',
        'ensure-import',
        'export',
        'insert-after',
        'insert-array-entry',
        'insert-before',
        'insert-before-closing-brace',
        'insert-between-anchors',
        'insert-enum-entry',
        'insert-object-entry',
        'replace',
      ].sort(),
    );
  });

  test('validatePlannedOperation suggests the field a near-miss meant', () => {
    const s = validatePlannedOperation({ kind: 'insert-object-entry', objectName: 'M', key: 'a', value: 'b' });
    expect(s.missing).toEqual(['entryKey', 'entryValue']);
    expect(s.suggestions).toEqual(['key→entryKey', 'value→entryValue']);
  });
});
