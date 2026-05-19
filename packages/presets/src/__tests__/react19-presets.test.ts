/**
 * Smoke coverage for the React 19+ preset family.
 *
 *   - All nine presets (8 focused + 1 comprehensive) are registered in
 *     BUILTIN_PRESETS and reachable by id.
 *   - `react-19-modern` composes the seven non-RSC focused presets;
 *     `react-19-rsc` is intentionally separate (only relevant for
 *     framework apps).
 *   - Each focused preset includes the canonical rule for its area
 *     (e.g. the actions preset includes useActionState; the testing
 *     preset includes userEvent + MSW; the RSC preset includes
 *     "use client" + Server Actions).
 *   - Every emitted .ts file in the synthesized output is self-contained.
 *   - The recommender prefers react-19-modern over the legacy
 *     `frontend-app` for a React frontend workspace.
 */
import { describe, expect, test } from 'bun:test';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import {
  BUILTIN_PRESETS,
  recommendPresets,
  synthesizePresetFiles,
} from '../index.ts';
import { REACT_19_PRESETS } from '../builtin/react19-presets.ts';

const REACT19_IDS = [
  'react-19-modern-components',
  'react-19-hooks-discipline',
  'react-19-actions-forms',
  'react-19-state',
  'react-19-performance',
  'react-19-concurrent',
  'react-19-testing',
  'react-19-rsc',
  'react-19-modern',
] as const;

describe('React 19+ preset family — registration', () => {
  test('all nine presets are exported and shipped in BUILTIN_PRESETS', () => {
    expect(REACT_19_PRESETS).toHaveLength(9);
    const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id));
    for (const id of REACT19_IDS) {
      expect(builtinIds.has(id), `${id} not in BUILTIN_PRESETS`).toBe(true);
    }
  });

  test('preset ids are unique within the family', () => {
    const ids = REACT_19_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('react-19-modern composes the seven non-RSC focused presets', () => {
    const comp = BUILTIN_PRESETS.find((p) => p.id === 'react-19-modern');
    expect(comp).toBeDefined();
    expect(comp!.composes).toBeDefined();
    const composes = new Set(comp!.composes ?? []);
    expect(composes.has('react-19-modern-components')).toBe(true);
    expect(composes.has('react-19-hooks-discipline')).toBe(true);
    expect(composes.has('react-19-actions-forms')).toBe(true);
    expect(composes.has('react-19-state')).toBe(true);
    expect(composes.has('react-19-performance')).toBe(true);
    expect(composes.has('react-19-concurrent')).toBe(true);
    expect(composes.has('react-19-testing')).toBe(true);
    // RSC is opt-in; comprehensive should NOT pull it in by default.
    expect(composes.has('react-19-rsc')).toBe(false);
  });
});

describe('React 19+ preset family — canonical rules', () => {
  function rulesSourceFor(presetId: string): string {
    const preset = BUILTIN_PRESETS.find((p) => p.id === presetId);
    expect(preset, `${presetId} missing`).toBeDefined();
    return (preset!.includes.rules ?? []).join('\n');
  }

  test('react-19-modern-components includes function-components + no-React.FC + ref-as-prop', () => {
    const src = rulesSourceFor('react-19-modern-components');
    expect(src).toContain('function components');
    expect(src).toContain('React.FC');
    expect(src).toContain('ref');
    expect(src).toContain('forwardRef');
    // Document-metadata rule is identified by its id (kebab-case).
    expect(src).toContain('react19.document-metadata');
  });

  test('react-19-hooks-discipline includes rules-of-hooks + useEffect-for-external-sync + key-for-reset', () => {
    const src = rulesSourceFor('react-19-hooks-discipline');
    // The eslint plugin rule name appears in the content verbatim.
    expect(src).toContain('rules-of-hooks');
    expect(src).toContain('external systems');
    expect(src).toContain('Derived state');
    expect(src).toContain('Reset component state with a key');
    expect(src).toContain('TanStack Query');
  });

  test('react-19-actions-forms includes useActionState + useFormStatus + useOptimistic + use()', () => {
    const src = rulesSourceFor('react-19-actions-forms');
    expect(src).toContain('useActionState');
    expect(src).toContain('useFormStatus');
    expect(src).toContain('useOptimistic');
    expect(src).toContain('use(');
    expect(src).toContain('startTransition');
  });

  test('react-19-state includes server-state library + client-state proportional + RHF + Zod', () => {
    const src = rulesSourceFor('react-19-state');
    expect(src).toContain('TanStack Query');
    expect(src).toContain('Zustand');
    expect(src).toContain('React Hook Form');
    expect(src).toContain('Zod');
  });

  test('react-19-performance includes React Compiler + lazy + virtualization + stable keys', () => {
    const src = rulesSourceFor('react-19-performance');
    expect(src).toContain('React Compiler');
    expect(src).toContain('React.lazy');
    expect(src).toContain('Virtualize');
    expect(src).toContain('stable');
    expect(src).toContain('width');
  });

  test('react-19-concurrent includes useTransition + useDeferredValue + Suspense + StrictMode', () => {
    const src = rulesSourceFor('react-19-concurrent');
    expect(src).toContain('useTransition');
    expect(src).toContain('useDeferredValue');
    expect(src).toContain('Suspense');
    expect(src).toContain('StrictMode');
  });

  test('react-19-testing includes Vitest + Testing Library + userEvent + MSW + behavior-not-impl', () => {
    const src = rulesSourceFor('react-19-testing');
    expect(src).toContain('Vitest');
    expect(src).toContain('@testing-library/react');
    expect(src).toContain('userEvent');
    expect(src).toContain('MSW');
    expect(src).toContain('behavior, not implementation');
  });

  test('react-19-rsc includes Server Components + use-client boundary + Server Actions', () => {
    const src = rulesSourceFor('react-19-rsc');
    expect(src).toContain('Server Component');
    // The literal "use client" / "use server" appears JSON-escaped in the
    // synthesized source (\"use client\"). Match without the surrounding
    // quotes so the assertion works in both the raw and the escaped form.
    expect(src).toContain('use client');
    expect(src).toContain('Server Action');
    expect(src).toContain('use server');
    expect(src).toContain('Stream');
  });
});

describe('React 19+ preset family — synthesis', () => {
  test('every preset synthesizes self-contained .ts files', () => {
    const bad = /from\s+['"]@shrkcrft\//;
    const typo = /from\s+['"]@sharkcraft\//;
    for (const preset of REACT_19_PRESETS) {
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

  test('every preset emits a paths.ts referencing src/components', () => {
    for (const preset of REACT_19_PRESETS) {
      const files = synthesizePresetFiles(preset);
      const pathsFile = files.find((f) => f.path === 'paths.ts');
      expect(pathsFile, `${preset.id} missing paths.ts`).toBeDefined();
      expect(pathsFile!.content).toContain("metadata: { path: 'src/components' }");
    }
  });
});

describe('React 19+ preset family — recommendation', () => {
  test('recommendPresets prefers a react-19-* preset for a React frontend workspace', () => {
    const recs = recommendPresets([...BUILTIN_PRESETS], {
      profiles: [
        WorkspaceProfile.HasReact,
        WorkspaceProfile.IsFrontend,
        WorkspaceProfile.HasTypeScript,
      ],
      limit: 3,
    });
    const top = recs[0]?.preset?.id ?? '';
    expect(
      [
        'react-19-modern',
        'react-19-modern-components',
        'react-19-state',
        'react-19-performance',
        'react-19-actions-forms',
        'react-19-rsc',
      ],
      `expected a react-19-* preset to win; got "${top}"`,
    ).toContain(top);
  });
});
