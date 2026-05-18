import { describe, expect, test } from 'bun:test';
import { definePackManifest, validatePackManifest } from '../pack-manifest.ts';

describe('validatePackManifest', () => {
  test('accepts a minimal valid manifest', () => {
    const r = validatePackManifest({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@x/y', version: '0.1.0' },
      contributions: {},
    });
    expect(r.valid).toBe(true);
    expect(r.issues.length).toBe(0);
  });

  test('rejects wrong schema marker', () => {
    const r = validatePackManifest({
      schema: 'wrong/v0',
      info: { name: '@x/y', version: '0.1.0' },
      contributions: {},
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'schema')).toBe(true);
  });

  test('rejects missing info', () => {
    const r = validatePackManifest({
      schema: 'sharkcraft.pack/v1',
      contributions: {},
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'info')).toBe(true);
  });

  test('rejects non-array contributions', () => {
    const r = validatePackManifest({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@x/y', version: '0.1.0' },
      contributions: { knowledgeFiles: 'not-an-array' as never },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'contributions.knowledgeFiles')).toBe(true);
  });

  test('definePackManifest returns the manifest as-is', () => {
    const m = definePackManifest({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@a/b', version: '1.0.0' },
      contributions: { templateFiles: ['./t.ts'] },
    });
    expect(m.info.name).toBe('@a/b');
  });
});
