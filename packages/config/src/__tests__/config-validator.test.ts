import { describe, expect, test } from 'bun:test';
import type { ISharkCraftConfig } from '../sharkcraft-config.ts';
import { validateConfig } from '../config-validator.ts';

describe('validateConfig', () => {
  test('a well-formed config is valid with no issues', () => {
    const r = validateConfig({
      projectName: 'demo',
      defaultMaxTokens: 4000,
      knowledgeFiles: ['knowledge.ts'],
    });
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
  });

  test('an empty config object is valid', () => {
    expect(validateConfig({}).valid).toBe(true);
  });

  test('defaultMaxTokens <= 0 is an error', () => {
    const r = validateConfig({ defaultMaxTokens: 0 });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'defaultMaxTokens' && i.severity === 'error')).toBe(true);
  });

  test('a non-array file list is an error', () => {
    const r = validateConfig({ knowledgeFiles: 'knowledge.ts' as unknown as string[] });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'knowledgeFiles')).toBe(true);
  });

  test('a non-string projectName is an error', () => {
    const r = validateConfig({ projectName: 42 as unknown as string });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'projectName')).toBe(true);
  });

  test('null / undefined / non-object input is a root error, not a throw', () => {
    for (const bad of [null, undefined, 'nope', 7]) {
      const r = validateConfig(bad as unknown as ISharkCraftConfig);
      expect(r.valid).toBe(false);
      expect(r.issues[0]?.field).toBe('<root>');
    }
  });
});
