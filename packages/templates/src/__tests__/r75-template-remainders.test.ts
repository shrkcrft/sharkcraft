/**
 * Round 11 §4.6#3 — a template can declare what it deliberately does NOT
 * scaffold. `defineTemplate` preserves and freezes the fields; the printable
 * block is one function every surface prints.
 */
import { describe, expect, test } from 'bun:test';
import { defineTemplate, isTemplateRemainder, TemplateRemainder, templateRemainderLines } from '../index.ts';

describe('template remainders', () => {
  const t = defineTemplate({
    id: 'mod.new',
    name: 'New module',
    description: 'd',
    tags: [],
    scope: [],
    appliesWhen: [],
    variables: [],
    files: () => [],
    notScaffolded: [TemplateRemainder.BuildConfig, 'path-alias'],
    manualSteps: [{ description: 'Add the package to tsconfig paths', covers: ['path-alias'] }],
  });

  test('defineTemplate preserves notScaffolded / manualSteps and freezes them', () => {
    expect(t.notScaffolded).toEqual(['build-config', 'path-alias']);
    expect(Object.isFrozen(t.notScaffolded)).toBe(true);
    expect(Object.isFrozen(t.manualSteps)).toBe(true);
    expect(Object.isFrozen(t.manualSteps![0])).toBe(true);
    expect(Object.isFrozen(t.manualSteps![0]!.covers)).toBe(true);
  });

  test('templateRemainderLines renders the one printable block (empty when nothing is declared)', () => {
    expect(templateRemainderLines(t)).toEqual([
      'Not scaffolded by this template: build-config, path-alias',
      'Manual steps:',
      '  • Add the package to tsconfig paths (covers: path-alias)',
    ]);
    expect(templateRemainderLines({})).toEqual([]);
  });

  test('the vocabulary is closed', () => {
    expect(isTemplateRemainder('build-config')).toBe(true);
    expect(isTemplateRemainder('bogus')).toBe(false);
  });
});
