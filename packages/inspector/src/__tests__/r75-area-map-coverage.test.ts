/**
 * Round 11 §6.4(a) — the area map reports its own classification rate, a
 * project can supply patterns, and derived views degrade loudly.
 *
 * The defect: the classifier was frozen to one layout (`packages/<core|ui|…>`,
 * `src/…`). A two-level package root (`libs/<group>/<lib>/…`) classified ~14%
 * of files, with no config surface to fix it, and impact / risk views built on
 * the map inherited the blind spot without saying so.
 *
 * Every fixture is a real temp project with a real sharkcraft.config.ts loaded
 * through inspectSharkcraft — never a hand-built inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AreaKind as CoreAreaKind } from '@shrkcrft/core';
import { SharkCraftConfigSchema } from '@shrkcrft/config';
import {
  AreaKind,
  areaIdOf,
  buildAreaMap,
  createAreaClassifier,
  renderAreaMapMarkdown,
  renderAreaMapText,
} from '../area-map.ts';
import { analyzeImpact } from '../impact-analysis.ts';
import { renderImpactMarkdown, renderImpactText } from '../impact-render.ts';
import { buildChangesSummary } from '../changes-summary.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** libs/<group>/<lib>/src/*.ts — 3 groups × 5 libs × (6 sources + 1 spec). */
function libsProject(areaMap?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-areas-'));
  roots.push(root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  write('package.json', JSON.stringify({ name: 'r75-areas', version: '0.0.0' }));
  write(
    'sharkcraft/sharkcraft.config.ts',
    `export default ${JSON.stringify({ projectName: 'r75-areas', ...(areaMap ? { areaMap } : {}) })};\n`,
  );
  for (const group of ['platform', 'feature', 'shared']) {
    for (const lib of ['core', 'ui', 'data', 'util', 'api-client']) {
      for (let i = 0; i < 6; i += 1) write(`libs/${group}/${lib}/src/m${i}.ts`, `export const v${i} = ${i};\n`);
      write(`libs/${group}/${lib}/src/m0.spec.ts`, 'export {};\n');
    }
  }
  return root;
}

describe('the area map reports its own coverage', () => {
  test('a two-level libs layout with no config: low rate, degraded, and an actionable sample', async () => {
    const inspection = await inspectSharkcraft({ cwd: libsProject() });
    const map = buildAreaMap(inspection);
    expect(map.patternSource).toBe('built-in');
    expect(map.classificationRate).toBeLessThan(0.2);
    expect(map.degraded).toBe(true);
    expect(map.unclassifiedSample.length).toBe(20);
    expect(map.unclassifiedSample.every((p) => p.startsWith('libs/') || p.startsWith('package') || p.startsWith('sharkcraft'))).toBe(true);
    expect(renderAreaMapText(map)).toContain('! area attribution degraded');
    expect(renderAreaMapMarkdown(map)).toContain('**Warning:** area attribution degraded');
  });

  test('config patterns classify first; the rate rises; the source says config+built-in', async () => {
    const inspection = await inspectSharkcraft({
      cwd: libsProject({
        patterns: [
          { kind: 'core', match: ['libs/*/core/**'] },
          { kind: 'ui', match: ['libs/*/ui/**'], id: 'ui-libs' },
        ],
      }),
    });
    expect(inspection.configLoadError).toBeUndefined();
    const map = buildAreaMap(inspection);
    expect(map.patternSource).toBe('config+built-in');
    const bare = buildAreaMap(await inspectSharkcraft({ cwd: libsProject() }));
    expect(map.classificationRate).toBeGreaterThan(bare.classificationRate);
    expect(map.areas.some((a) => a.kind === AreaKind.Core)).toBe(true);
    expect(map.areas.some((a) => a.id === 'ui:ui-libs')).toBe(true);
    // A config pattern outranks the built-in `.spec.` rule for the files it names.
    expect(createAreaClassifier(inspection.config?.areaMap)('libs/platform/core/src/m0.spec.ts').kind).toBe(AreaKind.Core);
  });

  test('replaceDefaults drops the built-in table: a .spec.ts outside the patterns is no longer Tests', async () => {
    const inspection = await inspectSharkcraft({
      cwd: libsProject({ patterns: [{ kind: 'core', match: ['libs/*/core/**'] }], replaceDefaults: true }),
    });
    const map = buildAreaMap(inspection);
    expect(map.patternSource).toBe('config');
    expect(map.areas.some((a) => a.kind === AreaKind.Tests)).toBe(false);
    const classify = createAreaClassifier(inspection.config?.areaMap);
    expect(classify('libs/feature/ui/src/m0.spec.ts').kind).toBe(AreaKind.Unknown);
  });

  test('property: classified + unclassified = total, 0 ≤ rate ≤ 1, the sample is sorted and ≤ 20', async () => {
    for (const cfg of [undefined, { patterns: [{ kind: 'core', match: ['libs/**'] }] }, { replaceDefaults: true }]) {
      const map = buildAreaMap(await inspectSharkcraft({ cwd: libsProject(cfg) }));
      expect(map.classifiedFiles + map.unclassifiedFiles).toBe(map.totalFiles);
      expect(map.classificationRate).toBeGreaterThanOrEqual(0);
      expect(map.classificationRate).toBeLessThanOrEqual(1);
      expect(map.unclassifiedSample.length).toBeLessThanOrEqual(20);
      expect([...map.unclassifiedSample].sort()).toEqual([...map.unclassifiedSample]);
    }
  });

  test('minClassificationRate sets the degraded threshold', async () => {
    const map = buildAreaMap(await inspectSharkcraft({ cwd: libsProject({ minClassificationRate: 0 }) }));
    expect(map.minClassificationRate).toBe(0);
    expect(map.degraded).toBe(false);
  });
});

describe('derived views inherit the coverage and print it', () => {
  test('impact on an unclassified target: areaCoverage, a risk reason, and the loud line (text + markdown)', async () => {
    const inspection = await inspectSharkcraft({ cwd: libsProject() });
    const impact = await analyzeImpact(inspection, { files: ['libs/feature/data/src/m1.ts'] });
    expect(impact.areaCoverage.degraded).toBe(true);
    expect(impact.areaCoverage.unclassifiedTargets).toEqual(['libs/feature/data/src/m1.ts']);
    expect(impact.riskReasons.map((r) => r.code)).toContain('area-attribution-degraded');
    expect(renderImpactText(impact)).toContain('Area attribution: degraded');
    expect(renderImpactMarkdown(impact)).toContain('Area attribution: degraded');
  });

  test('a target a config pattern classifies is not reported unclassified', async () => {
    const inspection = await inspectSharkcraft({
      cwd: libsProject({ patterns: [{ kind: 'core', match: ['libs/**'] }] }),
    });
    const impact = await analyzeImpact(inspection, { files: ['libs/feature/data/src/m1.ts'] });
    expect(impact.areaCoverage.unclassifiedTargets).toEqual([]);
    expect(impact.areaCoverage.degraded).toBe(false);
    expect(impact.riskReasons.map((r) => r.code)).not.toContain('area-attribution-degraded');
    expect(renderImpactText(impact)).not.toContain('Area attribution:');
  });

  test('a PARTIAL core pattern makes only the files it matches core — never every libs/ file (review #2)', async () => {
    const inspection = await inspectSharkcraft({
      cwd: libsProject({ patterns: [{ kind: 'core', match: ['libs/*/core/**'] }] }),
    });
    // Outside the pattern: in no known area, and NOT core. The old prefix match
    // on `paths` (only the top segment, `libs`) hit core:libs for every libs/
    // file, while areaCoverage called the same file unclassified.
    const outside = await analyzeImpact(inspection, { files: ['libs/feature/data/src/m1.ts'] });
    expect(outside.affectedAreas.map((a) => a.id)).toEqual(['unknown:libs']);
    expect(outside.riskReasons.map((r) => r.code)).not.toContain('core-area');
    expect(outside.affectedPolicies.map((p) => p.policyId)).not.toContain('core.protected-area');
    expect(outside.areaCoverage.unclassifiedTargets).toEqual(['libs/feature/data/src/m1.ts']);

    const inside = await analyzeImpact(inspection, { files: ['libs/platform/core/src/m1.ts'] });
    expect(inside.affectedAreas.map((a) => a.id)).toEqual(['core:libs']);
    expect(inside.riskReasons.map((r) => r.code)).toContain('core-area');
    expect(inside.areaCoverage.unclassifiedTargets).toEqual([]);
  });

  test('property: every affected area is the entry buildAreaMap keys that file by (one id, one classifier)', async () => {
    const inspection = await inspectSharkcraft({
      cwd: libsProject({
        patterns: [
          { kind: 'core', match: ['libs/*/core/**'] },
          { kind: 'ui', match: ['libs/*/ui/**'], id: 'ui-libs' },
        ],
      }),
    });
    const map = buildAreaMap(inspection);
    const classify = createAreaClassifier(inspection.config?.areaMap);
    for (const f of [
      'libs/feature/data/src/m1.ts',
      'libs/platform/core/src/m0.spec.ts',
      'libs/shared/ui/src/m2.ts',
      'libs/feature/util/src/m0.spec.ts',
    ]) {
      const impact = await analyzeImpact(inspection, { files: [f] });
      const id = areaIdOf(classify(f), f);
      expect({ f, ids: impact.affectedAreas.map((a) => a.id) }).toEqual({ f, ids: [id] });
      const entry = map.areas.find((a) => a.id === id);
      expect({ f, kind: impact.affectedAreas[0]?.kind }).toEqual({ f, kind: entry?.kind });
    }
  });

  test('one authority: the changes summary and the area map attribute a config-matched file to the same pattern', async () => {
    const inspection = await inspectSharkcraft({
      cwd: libsProject({ patterns: [{ kind: 'ui', match: ['libs/*/ui/**'], id: 'ui-libs' }] }),
    });
    const file = 'libs/shared/ui/src/m2.ts';
    const summary = await buildChangesSummary(inspection, { files: [file] });
    expect(summary.files.find((f) => f.path === file)?.area).toBe('ui-libs');
    const map = buildAreaMap(inspection);
    expect(map.areas.find((a) => a.id === 'ui:ui-libs')?.kind).toBe(AreaKind.Ui);
  });
});

describe('the config schema validates areaMap against the core enum', () => {
  const parse = (areaMap: unknown): boolean =>
    SharkCraftConfigSchema.safeParse({ projectName: 'x', areaMap }).success;

  test('accepts every AreaKind except unknown (parity with the core enum)', () => {
    for (const kind of Object.values(CoreAreaKind)) {
      expect({ kind, ok: parse({ patterns: [{ kind, match: ['a/**'] }] }) }).toEqual({
        kind,
        ok: kind !== CoreAreaKind.Unknown,
      });
    }
  });

  test('rejects an unknown kind, an empty match list, and an out-of-range rate', () => {
    expect(parse({ patterns: [{ kind: 'backend', match: ['a/**'] }] })).toBe(false);
    expect(parse({ patterns: [{ kind: 'core', match: [] }] })).toBe(false);
    expect(parse({ minClassificationRate: 1.5 })).toBe(false);
    expect(parse({ patterns: [{ kind: 'core', match: ['a/**'], extra: 1 }] })).toBe(false);
  });

  test('the inspector re-exports the same enum core defines', () => {
    expect(AreaKind).toBe(CoreAreaKind);
  });
});
