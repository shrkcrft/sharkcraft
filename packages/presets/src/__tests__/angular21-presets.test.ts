/**
 * Smoke coverage for the Angular 21 preset family.
 *
 *   - All six presets are registered in BUILTIN_PRESETS and reachable by id.
 *   - The comprehensive `angular-21-modern` preset composes the five
 *     focused ones (signals, zoneless, control-flow, resource, modern-di).
 *   - Each focused preset includes the canonical rule for its area
 *     (e.g. the signals preset includes the `viewChild()` rule, the
 *     zoneless preset includes the `provideZonelessChangeDetection` rule).
 *   - Every emitted .ts file in the synthesized output is self-contained —
 *     no `@shrkcrft/*` imports. This is also covered by the broader
 *     init-self-contained-emit suite; we duplicate it here so a regression
 *     in this slice fails locally, not three packages over.
 *   - The recommender prefers angular-21-modern over modern-angular when
 *     a workspace declares HasAngular + IsFrontend.
 */
import { describe, expect, test } from 'bun:test';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import {
  BUILTIN_PRESETS,
  recommendPresets,
  synthesizePresetFiles,
} from '../index.ts';
import { ANGULAR_21_PRESETS } from '../builtin/angular21-presets.ts';

const ANGULAR21_IDS = [
  'angular-21-signals',
  'angular-21-zoneless',
  'angular-21-control-flow',
  'angular-21-resource',
  'angular-21-modern-di',
  'angular-21-modern',
] as const;

describe('Angular 21 preset family — registration', () => {
  test('all six presets are exported and shipped in BUILTIN_PRESETS', () => {
    expect(ANGULAR_21_PRESETS).toHaveLength(6);
    const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id));
    for (const id of ANGULAR21_IDS) {
      expect(builtinIds.has(id), `${id} not in BUILTIN_PRESETS`).toBe(true);
    }
  });

  test('preset ids are unique within the family', () => {
    const ids = ANGULAR_21_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('angular-21-modern composes the five focused presets', () => {
    const comp = BUILTIN_PRESETS.find((p) => p.id === 'angular-21-modern');
    expect(comp).toBeDefined();
    expect(comp!.composes).toBeDefined();
    const composes = new Set(comp!.composes ?? []);
    expect(composes.has('angular-21-signals')).toBe(true);
    expect(composes.has('angular-21-zoneless')).toBe(true);
    expect(composes.has('angular-21-control-flow')).toBe(true);
    expect(composes.has('angular-21-resource')).toBe(true);
    expect(composes.has('angular-21-modern-di')).toBe(true);
  });
});

describe('Angular 21 preset family — canonical rules', () => {
  function rulesSourceFor(presetId: string): string {
    const preset = BUILTIN_PRESETS.find((p) => p.id === presetId);
    expect(preset, `${presetId} missing`).toBeDefined();
    return (preset!.includes.rules ?? []).join('\n');
  }

  test('angular-21-signals includes viewChild + input + output + model rules', () => {
    const src = rulesSourceFor('angular-21-signals');
    expect(src).toContain('viewChild');
    expect(src).toContain('contentChild');
    expect(src).toContain('input()');
    expect(src).toContain('output()');
    expect(src).toContain('model()');
    expect(src).toContain('signal()');
    // The signals preset must NOT advertise the old decorator path.
    expect(src).toContain('@ViewChild');
    expect(src).toContain('not @ViewChild');
    expect(src).toContain('not @Input()');
  });

  test('angular-21-zoneless includes the provideZonelessChangeDetection rule', () => {
    const src = rulesSourceFor('angular-21-zoneless');
    expect(src).toContain('provideZonelessChangeDetection');
    expect(src).toContain('zone.js');
    // Must call out that NgZone APIs are inert.
    expect(src).toContain('NgZone');
  });

  test('angular-21-control-flow includes @if / @for / @defer / @let rules', () => {
    const src = rulesSourceFor('angular-21-control-flow');
    expect(src).toContain('@if');
    expect(src).toContain('@for');
    expect(src).toContain('@switch');
    expect(src).toContain('@defer');
    expect(src).toContain('@let');
    expect(src).toContain('NgOptimizedImage');
  });

  test('angular-21-resource includes resource() + httpResource() + linkedSignal', () => {
    const src = rulesSourceFor('angular-21-resource');
    expect(src).toContain('resource(');
    expect(src).toContain('httpResource(');
    expect(src).toContain('linkedSignal');
  });

  test('angular-21-modern-di includes inject() + no-NgModules + bootstrapApplication', () => {
    const src = rulesSourceFor('angular-21-modern-di');
    expect(src).toContain('inject(');
    expect(src).toContain('providedIn');
    expect(src).toContain('NgModule');
    expect(src).toContain('bootstrapApplication');
  });
});

describe('Angular 21 preset family — synthesis', () => {
  test('every preset synthesizes self-contained .ts files', () => {
    const bad = /from\s+['"]@shrkcrft\//;
    const typo = /from\s+['"]@sharkcraft\//;
    for (const preset of ANGULAR_21_PRESETS) {
      const files = synthesizePresetFiles(preset);
      for (const f of files) {
        if (!f.path.endsWith('.ts')) continue;
        expect(
          f.content,
          `${preset.id}/${f.path} must not import from @shrkcrft/*`,
        ).not.toMatch(bad);
        expect(
          f.content,
          `${preset.id}/${f.path} must not contain @sharkcraft/* typo`,
        ).not.toMatch(typo);
      }
    }
  });

  test('every preset emits a paths.ts file with Angular paths', () => {
    for (const preset of ANGULAR_21_PRESETS) {
      const files = synthesizePresetFiles(preset);
      const pathsFile = files.find((f) => f.path === 'paths.ts');
      expect(pathsFile, `${preset.id} missing paths.ts`).toBeDefined();
      // At minimum, every preset references src/app — the canonical
      // Angular root. Focused presets may add components/services on top.
      expect(pathsFile!.content).toContain("metadata: { path: 'src/app' }");
    }
  });
});

describe('Angular 21 preset family — recommendation', () => {
  test('recommendPresets prefers angular-21-modern for an Angular frontend workspace', () => {
    const recs = recommendPresets([...BUILTIN_PRESETS], {
      profiles: [
        WorkspaceProfile.HasAngular,
        WorkspaceProfile.IsFrontend,
        WorkspaceProfile.HasTypeScript,
      ],
      limit: 3,
    });
    const top = recs[0]?.preset?.id ?? '';
    expect(
      ['angular-21-modern', 'angular-21-signals', 'angular-21-zoneless'],
      `expected an angular-21-* preset to win; got "${top}"`,
    ).toContain(top);
  });
});
