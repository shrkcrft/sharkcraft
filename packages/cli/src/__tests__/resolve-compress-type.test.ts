import { describe, expect, test } from 'bun:test';
import { EContentType } from '@shrkcrft/compress';
import { resolveCompressType } from '../output/resolve-compress-type.ts';

describe('resolveCompressType', () => {
  test('missing or empty value → no type, no warning (auto-detect)', () => {
    expect(resolveCompressType(undefined)).toEqual({});
    expect(resolveCompressType('')).toEqual({});
  });

  test('a valid EContentType wire string forces that type with no warning', () => {
    expect(resolveCompressType('json')).toEqual({ type: EContentType.Json });
    expect(resolveCompressType('json-array')).toEqual({ type: EContentType.JsonArray });
    expect(resolveCompressType('build-log')).toEqual({ type: EContentType.BuildLog });
    expect(resolveCompressType('git-diff')).toEqual({ type: EContentType.GitDiff });
  });

  test('every EContentType member round-trips through its wire string', () => {
    for (const t of Object.values(EContentType)) {
      expect(resolveCompressType(t)).toEqual({ type: t });
    }
  });

  test('an unknown type is reported (not silently dropped) and forces no type', () => {
    // `log` is the exact value the parser test uses, but it is NOT valid —
    // `build-log` is. Before this fix it was silently auto-detected.
    const r = resolveCompressType('log');
    expect(r.type).toBeUndefined();
    expect(r.warning).toContain('unknown --compress-type "log"');
    expect(r.warning).toContain('auto-detecting');
  });

  test('the warning lists the valid types so the user can self-correct', () => {
    const r = resolveCompressType('jsonn');
    expect(r.type).toBeUndefined();
    expect(r.warning).toContain('json-array');
    expect(r.warning).toContain('build-log');
    expect(r.warning).toContain('markdown');
  });
});
