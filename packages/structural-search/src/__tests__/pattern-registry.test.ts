import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PatternRegistryStore,
  STRUCTURAL_PATTERN_REGISTRY_SCHEMA,
  STRUCTURAL_PATTERN_SCHEMA,
  validatePatternEnvelope,
  type IPatternEnvelope,
} from '../index.ts';

function envelope(over: Partial<IPatternEnvelope> = {}): IPatternEnvelope {
  return {
    schema: STRUCTURAL_PATTERN_SCHEMA,
    id: 'demo.controller',
    title: 'Controller decorator',
    pattern: {
      kind: 'Decorator',
      name: 'Controller',
      isCall: true,
    },
    ...over,
  };
}

describe('validatePatternEnvelope', () => {
  test('accepts a well-formed envelope', () => {
    expect(validatePatternEnvelope(envelope())).toEqual({ ok: true });
  });

  test('rejects mismatched schema', () => {
    const e = envelope({ schema: 'sharkcraft.structural-pattern/v9' as never });
    const r = validatePatternEnvelope(e);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('schema mismatch');
  });

  test('rejects unknown pattern kind', () => {
    const e = envelope({
      pattern: { kind: 'NoSuchKind' } as never,
    });
    const r = validatePatternEnvelope(e);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('NoSuchKind');
  });

  test('rejects an invalid nameRegex', () => {
    const e = envelope({
      pattern: { kind: 'Identifier', nameRegex: '[unterminated' },
    });
    const r = validatePatternEnvelope(e);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('nameRegex');
  });
});

describe('PatternRegistryStore', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shrk-pat-reg-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('empty when no file exists yet', () => {
    const store = new PatternRegistryStore(root);
    expect(store.exists()).toBe(false);
    const reg = store.read();
    expect(reg.patterns).toEqual([]);
  });

  test('add() rejects an envelope without id', () => {
    const store = new PatternRegistryStore(root);
    const r = store.add(envelope({ id: undefined as never }));
    expect(r.result.ok).toBe(false);
  });

  test('add() rejects an envelope with an invalid pattern kind', () => {
    const store = new PatternRegistryStore(root);
    const r = store.add(envelope({ pattern: { kind: 'NoSuch' } as never }));
    expect(r.result.ok).toBe(false);
    expect(store.read().patterns).toEqual([]);
  });

  test('add() persists, replaces by id, and sorts entries', () => {
    const store = new PatternRegistryStore(root);
    store.add(envelope({ id: 'b' }));
    store.add(envelope({ id: 'a' }));
    const reg = store.read();
    expect(reg.patterns.map((p) => p.id)).toEqual(['a', 'b']);

    // Same id replaces, doesn't duplicate.
    store.add(envelope({ id: 'a', title: 'updated' }));
    const reg2 = store.read();
    expect(reg2.patterns.map((p) => p.id)).toEqual(['a', 'b']);
    expect(reg2.patterns[0]?.title).toBe('updated');
  });

  test('remove() returns true on hit, false on miss', () => {
    const store = new PatternRegistryStore(root);
    store.add(envelope({ id: 'a' }));
    expect(store.remove('a')).toBe(true);
    expect(store.remove('a')).toBe(false);
  });

  test('validateAll() stamps lastValidatedAt and counts failures', () => {
    const store = new PatternRegistryStore(root);
    store.add(envelope({ id: 'good' }));
    // Manually inject an invalid entry by direct write (simulates a
    // hand-edited registry or a future schema drift).
    const reg = store.read();
    store.write({
      schema: STRUCTURAL_PATTERN_REGISTRY_SCHEMA,
      patterns: [
        ...reg.patterns,
        {
          id: 'bad',
          pattern: { kind: 'NoSuch' } as never,
          addedAt: new Date().toISOString(),
        },
      ],
    });
    const result = store.validateAll();
    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.id).toBe('bad');
    const reg2 = store.read();
    expect(reg2.patterns.find((p) => p.id === 'good')?.lastValidatedAt).toBeDefined();
    expect(reg2.patterns.find((p) => p.id === 'bad')?.lastValidationError).toBeDefined();
  });

  test('clear() removes the file', () => {
    const store = new PatternRegistryStore(root);
    store.add(envelope({ id: 'x' }));
    expect(store.exists()).toBe(true);
    expect(store.clear()).toBe(true);
    expect(store.exists()).toBe(false);
    expect(store.clear()).toBe(false);
  });

  test('rejects a registry file with the wrong top-level schema', () => {
    const store = new PatternRegistryStore(root);
    store.write({
      schema: 'sharkcraft.structural-pattern-registry/v9' as never,
      patterns: [],
    });
    // read() returns an empty registry on schema mismatch.
    const reg = store.read();
    expect(reg.patterns).toEqual([]);
  });
});
