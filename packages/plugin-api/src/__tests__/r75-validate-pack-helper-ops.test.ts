/**
 * Round 11 §3.2#4 — `validatePackHelper` checks every operation against the
 * closed allow-list. A helper op written with `key`/`value` instead of
 * `snippet` used to validate and then render nothing.
 */
import { describe, expect, test } from 'bun:test';
import { PACK_HELPER_OPERATION_FIELDS, validatePackHelper } from '../index.ts';

const BASE = {
  id: 'r75.helper',
  title: 'Helper',
  description: 'd',
  variables: [],
  safety: { outputKind: 'plan' },
};

describe('validatePackHelper — operations[]', () => {
  test('an op with key/value and no snippet is an error naming operations[0].snippet', () => {
    const v = validatePackHelper({
      ...BASE,
      operations: [{ kind: 'append-line', targetPath: 'src/a.ts', key: 'x', value: 'y', description: 'd' }],
    });
    expect(v.valid).toBe(false);
    const fields = v.issues.map((i) => i.field);
    expect(fields).toContain('operations[0].snippet');
    const unknown = v.issues.find((i) => i.severity === 'warning');
    expect(unknown?.message).toContain('key, value');
  });

  test('an unknown kind names the allowed kinds', () => {
    const v = validatePackHelper({ ...BASE, operations: [{ kind: 'insert-after', targetPath: 'a', snippet: 's', description: 'd' }] });
    expect(v.valid).toBe(false);
    expect(v.issues[0]!.field).toBe('operations[0].kind');
    expect(v.issues[0]!.message).toContain('append-line');
  });

  test('extra keys alone are a WARNING — the helper still loads', () => {
    const v = validatePackHelper({
      ...BASE,
      operations: [{ kind: 'remove-line', targetPath: 'a', find: 'x', description: 'd', bogus: 1 }],
    });
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([expect.objectContaining({ field: 'operations[0]', severity: 'warning' })]);
  });

  test('a well-formed op of every kind validates clean', () => {
    const sample: Record<string, unknown> = {
      targetPath: 'src/a.ts',
      snippet: 's',
      anchor: 'a',
      find: 'f',
      replaceWith: 'r',
      checklist: ['step'],
      description: 'd',
    };
    for (const [kind, spec] of Object.entries(PACK_HELPER_OPERATION_FIELDS)) {
      const op: Record<string, unknown> = { kind };
      for (const f of [...spec.required, ...spec.optional]) op[f] = sample[f];
      expect({ kind, issues: validatePackHelper({ ...BASE, operations: [op] }).issues }).toEqual({ kind, issues: [] });
    }
  });
});
