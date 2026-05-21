/**
 * surface profiles + brutally small core + agent gating
 * + preset surfaceProfile wiring.
 */
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_PROFILES,
  getProfile,
  indexProfiles,
} from '../surface/profiles.ts';
import {
  buildSurfaceSummary,
  findCommandInSummary,
} from '../surface/surface-summary.ts';
import { BOOTSTRAP_COMMANDS } from '../surface/tier.ts';
import { CommandTier } from '../commands/command-catalog.ts';
import { BUILTIN_PRESETS } from '@shrkcrft/presets';

describe('surface profiles', () => {
  test('built-in catalog includes all required profiles', () => {
    const ids = BUILTIN_PROFILES.map((p) => p.id);
    expect(ids).toContain('developer');
    expect(ids).toContain('small-app');
    expect(ids).toContain('monorepo');
    expect(ids).toContain('pack-author');
    expect(ids).toContain('ci');
    expect(ids).toContain('agent');
  });

  test('small-app profile hides monorepo verbs', () => {
    const p = getProfile('small-app')!;
    expect(p).toBeDefined();
    expect(p.hidden).toContain('bundle');
    expect(p.hidden).toContain('reposet');
    expect(p.hidden).toContain('packs new');
  });

  test('indexProfiles overlays pack profiles over builtin', () => {
    const packProfile = {
      id: 'developer', // same id as builtin
      description: 'pack-specific developer',
      source: 'pack' as const,
      pack: 'demo-pack',
      hidden: ['dev'],
    };
    const map = indexProfiles([packProfile]);
    const got = map.get('developer');
    expect(got?.source).toBe('pack');
    expect(got?.pack).toBe('demo-pack');
  });
});

describe('brutally small core', () => {
  test('BOOTSTRAP_COMMANDS excludes discovery verbs (commands, start-here)', () => {
    expect(BOOTSTRAP_COMMANDS).not.toContain('commands');
    expect(BOOTSTRAP_COMMANDS).not.toContain('start-here');
  });

  test('spine extractor filters to core verb allowlist', async () => {
    // The extractor itself is the gate that prevents gen/apply/plan-
    // review from drifting into core. Verify it ONLY emits allowlisted
    // verbs even when the spine pipeline lists everything.
    const { extractSpineCommands } = await import('../surface/spine-extractor.ts');
    const fakeSpine = [
      {
        id: 'engine.feature-dev',
        title: 'fake',
        steps: [
          { id: 's', type: 'command', cliCommands: [
            'bun run shrk context',
            'bun run shrk gen',
            'bun run shrk apply',
            'bun run shrk plan review',
            'bun run shrk check boundaries',
          ] },
        ],
      },
    ] as unknown as Parameters<typeof extractSpineCommands>[0];
    const verbs = extractSpineCommands(fakeSpine);
    expect([...verbs].sort()).toEqual(['check boundaries', 'context']);
  });

  test('engine repo surface has ≤12 core commands (with allowlist applied)', () => {
    // Now pass only what the allowlist would have produced.
    const summary = buildSurfaceSummary({
      spineCommands: new Set(['context', 'check boundaries']),
      packContributions: new Map(),
      surfaceConfig: undefined,
    });
    expect(summary.totals.core).toBeLessThanOrEqual(12);
    const ctx = findCommandInSummary(summary, 'context');
    expect(ctx?.tier).toBe(CommandTier.Core);
  });
});

describe('preset surfaceProfile wiring', () => {
  test('angular-app preset selects small-app profile', () => {
    const p = BUILTIN_PRESETS.find((x) => x.id === 'angular-app');
    expect(p).toBeDefined();
    expect((p as { surfaceProfile?: string }).surfaceProfile).toBe('small-app');
  });

  test('frontend-app preset also selects small-app profile', () => {
    const p = BUILTIN_PRESETS.find((x) => x.id === 'frontend-app');
    expect(p).toBeDefined();
    expect((p as { surfaceProfile?: string }).surfaceProfile).toBe('small-app');
  });
});

describe('start screen — curated ~20-command starter surface', () => {
  test('start screen surfaces the safe-codegen pair (gen + apply)', async () => {
    const mod = await import('../commands/help.command.ts');
    const out = mod.renderStartScreen();
    // The original alpha hid gen/apply behind `surface list`. After the
    // alpha.8 curation pass the canonical 20-command starter surface
    // surfaces them directly — paired with `check boundaries` and
    // `quality` so the safe-codegen flow is one read away. Discovery
    // (`surface list`) stays linked for the rest.
    expect(out).toMatch(/^\s*\$ shrk gen /m);
    expect(out).toMatch(/^\s*\$ shrk apply /m);
    expect(out).toMatch(/shrk surface list/);
  });
});
