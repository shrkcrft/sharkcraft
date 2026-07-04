/**
 * a25 §2.4 — `--resolve` bridges the vocabulary gap between the noun an author
 * types and the canonical registered id, via the declared `aliases` map AND
 * generic normalization (case-fold, singular/plural, suffix strip/append). No
 * layer resolves to an id that isn't actually declared.
 */
import { describe, expect, test } from 'bun:test';
import { ERegistryResolveVia, resolveRegistryNoun } from '../commands/registry-resolve.ts';

const IDS = ['foo-command', 'bar-command', 'widget', 'commands'];

describe('resolveRegistryNoun', () => {
  test('declared alias wins first', () => {
    const r = resolveRegistryNoun(IDS, { fooCmd: 'foo-command' }, 'fooCmd');
    expect(r.canonical).toBe('foo-command');
    expect(r.matched).toBe(true);
    expect(r.via).toBe(ERegistryResolveVia.Alias);
  });

  test('exact identity is reported as-is', () => {
    const r = resolveRegistryNoun(IDS, undefined, 'widget');
    expect(r.canonical).toBe('widget');
    expect(r.matched).toBe(true);
    expect(r.via).toBe(ERegistryResolveVia.Identity);
  });

  test('case-fold resolves a differently-cased noun', () => {
    const r = resolveRegistryNoun(IDS, undefined, 'Widget');
    expect(r.canonical).toBe('widget');
    expect(r.via).toBe(ERegistryResolveVia.Case);
  });

  test('singular/plural resolves commands ↔ command shapes', () => {
    // 'command' (singular) resolves to the declared plural id 'commands'.
    const r = resolveRegistryNoun(IDS, undefined, 'command');
    expect(r.canonical).toBe('commands');
    expect(r.matched).toBe(true);
    expect(r.via).toBe(ERegistryResolveVia.SingularPlural);
  });

  test('suffix append resolves a bare noun to its `-command` id', () => {
    const r = resolveRegistryNoun(IDS, undefined, 'foo');
    expect(r.canonical).toBe('foo-command');
    expect(r.matched).toBe(true);
    expect(r.via).toBe(ERegistryResolveVia.Suffix);
  });

  test('a genuinely unknown noun stays unmatched (honest not-declared)', () => {
    const r = resolveRegistryNoun(IDS, undefined, 'nonexistent-thing');
    expect(r.matched).toBe(false);
    expect(r.canonical).toBe('nonexistent-thing');
  });

  test('chains plural-strip THEN suffix-append for a doubly-off noun', () => {
    // `buttons` →(plural)→ `button` →(suffix)→ `button-command`. Neither the
    // singular/plural layer nor the suffix layer alone lands it.
    const r = resolveRegistryNoun(['button-command'], undefined, 'buttons');
    expect(r.matched).toBe(true);
    expect(r.canonical).toBe('button-command');
    expect(r.via).toBe(ERegistryResolveVia.SingularPluralSuffix);
  });

  test('does not over-resolve when no candidate lands on a declared id', () => {
    const r = resolveRegistryNoun(['button-command'], undefined, 'widgets');
    expect(r.matched).toBe(false);
    expect(r.canonical).toBe('widgets');
  });
});
