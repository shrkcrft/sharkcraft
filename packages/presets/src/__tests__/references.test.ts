import { describe, expect, test } from 'bun:test';
import {
  PresetRegistry,
  definePreset,
  resolvePreset,
  resolvePresetReferences,
  type IReferenceLookup,
} from '../index.ts';

function lookup(opts: {
  knowledge?: string[];
  rules?: string[];
  paths?: string[];
  templates?: string[];
  pipelines?: string[];
}): IReferenceLookup {
  return {
    hasKnowledge: (id) => (opts.knowledge ?? []).includes(id),
    hasRule: (id) => (opts.rules ?? []).includes(id),
    hasPath: (id) => (opts.paths ?? []).includes(id),
    hasTemplate: (id) => (opts.templates ?? []).includes(id),
    hasPipeline: (id) => (opts.pipelines ?? []).includes(id),
  };
}

describe('resolvePresetReferences', () => {
  test('all references resolve when present', () => {
    const p = definePreset({
      id: 'p',
      title: 'P',
      description: 'p',
      includes: {
        ruleIds: ['r1', 'r2'],
        templateIds: ['t1'],
        pipelineIds: ['pl1'],
      },
    });
    const reg = new PresetRegistry([p]);
    const resolved = resolvePreset(reg, 'p');
    const refs = resolvePresetReferences(
      resolved,
      lookup({ rules: ['r1', 'r2'], templates: ['t1'], pipelines: ['pl1'] }),
    );
    expect(refs.totalReferenced).toBe(4);
    expect(refs.totalMissing).toBe(0);
    expect(refs.rules.resolved).toEqual(['r1', 'r2']);
  });

  test('missing ids land in `missing` with the right kind', () => {
    const p = definePreset({
      id: 'p',
      title: 'P',
      description: 'p',
      includes: { templateIds: ['nope.template'] },
    });
    const reg = new PresetRegistry([p]);
    const resolved = resolvePreset(reg, 'p');
    const refs = resolvePresetReferences(resolved, lookup({}));
    expect(refs.totalMissing).toBe(1);
    expect(refs.missing[0]).toEqual({ kind: 'template', id: 'nope.template' });
  });

  test('references inherited from composed presets are still resolved', () => {
    const a = definePreset({
      id: 'a',
      title: 'A',
      description: 'a',
      includes: { ruleIds: ['from-a'] },
    });
    const b = definePreset({
      id: 'b',
      title: 'B',
      description: 'b',
      composes: ['a'],
      includes: { ruleIds: ['from-b'] },
    });
    const reg = new PresetRegistry([a, b]);
    const resolved = resolvePreset(reg, 'b');
    const refs = resolvePresetReferences(resolved, lookup({ rules: ['from-a', 'from-b'] }));
    expect(refs.totalReferenced).toBe(2);
    expect(refs.totalMissing).toBe(0);
  });
});
