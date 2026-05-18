import { describe, expect, test } from 'bun:test';
import { PresetRegistry, definePreset, resolvePreset } from '../index.ts';

describe('resolvePreset — composition', () => {
  test('simple composition merges includes from composed preset', () => {
    const a = definePreset({
      id: 'a',
      title: 'A',
      description: 'a',
      includes: { knowledge: [`{ id: 'a.k', value: 1 }`] },
    });
    const b = definePreset({
      id: 'b',
      title: 'B',
      description: 'b',
      composes: ['a'],
      includes: { knowledge: [`{ id: 'b.k', value: 2 }`] },
    });
    const reg = new PresetRegistry([a, b]);
    const r = resolvePreset(reg, 'b');
    expect(r.composedFrom).toEqual(['b', 'a']);
    expect(r.includes.knowledge?.length).toBe(2);
  });

  test('root override wins on duplicate snippet id', () => {
    const a = definePreset({
      id: 'a',
      title: 'A',
      description: 'a',
      includes: { knowledge: [`{ id: 'shared', from: 'a' }`] },
    });
    const b = definePreset({
      id: 'b',
      title: 'B',
      description: 'b',
      composes: ['a'],
      includes: { knowledge: [`{ id: 'shared', from: 'b' }`] },
    });
    const reg = new PresetRegistry([a, b]);
    const r = resolvePreset(reg, 'b');
    // First contributor wins (root first), so the kept snippet is from b.
    expect(r.includes.knowledge?.[0]).toContain("from: 'b'");
    expect(r.includes.knowledge?.length).toBe(1);
    expect(r.provenance.knowledge.get('shared')?.presetId).toBe('b');
  });

  test('nested composition: B composes A, C composes B', () => {
    const a = definePreset({ id: 'a', title: 'A', description: 'a', includes: { ruleIds: ['ra'] } });
    const b = definePreset({
      id: 'b',
      title: 'B',
      description: 'b',
      composes: ['a'],
      includes: { ruleIds: ['rb'] },
    });
    const c = definePreset({
      id: 'c',
      title: 'C',
      description: 'c',
      composes: ['b'],
      includes: { ruleIds: ['rc'] },
    });
    const reg = new PresetRegistry([a, b, c]);
    const r = resolvePreset(reg, 'c');
    expect(r.composedFrom).toEqual(['c', 'b', 'a']);
    expect(r.includes.ruleIds).toEqual(['rc', 'rb', 'ra']);
  });

  test('cycle detection: A composes B composes A', () => {
    const a = definePreset({ id: 'a', title: 'A', description: 'a', composes: ['b'], includes: {} });
    const b = definePreset({ id: 'b', title: 'B', description: 'b', composes: ['a'], includes: {} });
    const reg = new PresetRegistry([a, b]);
    const r = resolvePreset(reg, 'a');
    expect(r.issues.some((i) => i.code === 'composition-cycle')).toBe(true);
  });

  test('missing composed preset reports composed-not-found', () => {
    const a = definePreset({
      id: 'a',
      title: 'A',
      description: 'a',
      composes: ['nope'],
      includes: {},
    });
    const reg = new PresetRegistry([a]);
    const r = resolvePreset(reg, 'a');
    expect(r.issues.some((i) => i.code === 'composed-not-found')).toBe(true);
  });

  test('dedupe of recommendedNextCommands across root + composed', () => {
    const a = definePreset({
      id: 'a',
      title: 'A',
      description: 'a',
      includes: {},
      recommendedNextCommands: ['shrk doctor', 'shrk task "<task>"'],
    });
    const b = definePreset({
      id: 'b',
      title: 'B',
      description: 'b',
      composes: ['a'],
      includes: {},
      recommendedNextCommands: ['shrk doctor', 'shrk presets list'],
    });
    const reg = new PresetRegistry([a, b]);
    const r = resolvePreset(reg, 'b');
    expect(r.recommendedNextCommands).toEqual([
      'shrk doctor',
      'shrk presets list',
      'shrk task "<task>"',
    ]);
  });
});
