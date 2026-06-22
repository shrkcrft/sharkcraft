import { describe, expect, test } from 'bun:test';
import { parseDelegateEdit } from '../delegate/parse-delegate-edit.ts';

describe('parseDelegateEdit', () => {
  test('parses a valid edit with one export op', () => {
    const r = parseDelegateEdit(JSON.stringify({ ops: [{ targetPath: 'src/index.ts', operation: { kind: 'export', from: './foo' } }] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ops).toHaveLength(1);
      expect(r.value.ops[0]!.targetPath).toBe('src/index.ts');
      expect(r.value.ops[0]!.operation.kind).toBe('export');
    }
  });

  test('strips a markdown code fence a weak model wraps JSON in', () => {
    const fenced = '```json\n' + JSON.stringify({ ops: [{ targetPath: 'a.ts', operation: { kind: 'export', from: './x' } }] }) + '\n```';
    const r = parseDelegateEdit(fenced);
    expect(r.ok).toBe(true);
  });

  test('rejects non-JSON', () => {
    const r = parseDelegateEdit('this is not json');
    expect(r.ok).toBe(false);
  });

  test('rejects when ops is not an array', () => {
    const r = parseDelegateEdit(JSON.stringify({ ops: 'nope' }));
    expect(r.ok).toBe(false);
  });

  test('rejects an op missing targetPath', () => {
    const r = parseDelegateEdit(JSON.stringify({ ops: [{ operation: { kind: 'export', from: './x' } }] }));
    expect(r.ok).toBe(false);
  });

  test('rejects an op whose operation has no kind', () => {
    const r = parseDelegateEdit(JSON.stringify({ ops: [{ targetPath: 'a.ts', operation: { from: './x' } }] }));
    expect(r.ok).toBe(false);
  });
});
