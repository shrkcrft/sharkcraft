/**
 * surface summary: deterministic snapshot of every command's
 * tier, plus warnings for misconfigured surface{} blocks.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildSurfaceSummary,
  findCommandInSummary,
  SURFACE_SUMMARY_SCHEMA,
} from '../surface/surface-summary.ts';
import { CommandTier } from '../commands/command-catalog.ts';
import type { ITierResolverContext } from '../surface/tier.ts';

const EMPTY: ITierResolverContext = {
  spineCommands: new Set(),
  packContributions: new Map(),
  surfaceConfig: undefined,
};

describe('surface summary', () => {
  test('schema and totals are present', () => {
    const s = buildSurfaceSummary(EMPTY);
    expect(s.schema).toBe(SURFACE_SUMMARY_SCHEMA);
    expect(s.totals.core).toBeGreaterThan(0);
    expect(s.totals.extended).toBeGreaterThan(0);
    expect(s.totals.experimental).toBe(0); // no overrides, no packs
    expect(s.totals.callable).toBe(s.totals.core + s.totals.extended);
    expect(typeof s.hash).toBe('string');
    expect(s.hash.length).toBe(16);
  });

  test('hash is deterministic for the same input', () => {
    const s1 = buildSurfaceSummary(EMPTY);
    const s2 = buildSurfaceSummary(EMPTY);
    expect(s1.hash).toBe(s2.hash);
  });

  test('hash changes when surface config changes', () => {
    const s1 = buildSurfaceSummary(EMPTY);
    const s2 = buildSurfaceSummary({
      ...EMPTY,
      surfaceConfig: { hidden: ['inspect'] },
    });
    expect(s1.hash).not.toBe(s2.hash);
  });

  test('bootstrap commands appear in the core bucket', () => {
    const s = buildSurfaceSummary(EMPTY);
    const doctor = s.tiers.core.find((c) => c.command === 'doctor');
    expect(doctor).toBeDefined();
    expect(doctor!.callable).toBe(true);
  });

  test('warning emitted when surface.enabled references an unknown command', () => {
    const s = buildSurfaceSummary({
      ...EMPTY,
      surfaceConfig: { enabled: ['no-such-command'] },
    });
    expect(s.warnings.find((w) => w.code === 'unknown-command')).toBeDefined();
  });

  test('warning emitted when surface.hidden tries to hide a core command', () => {
    const s = buildSurfaceSummary({
      ...EMPTY,
      surfaceConfig: { hidden: ['doctor'] },
    });
    expect(s.warnings.find((w) => w.code === 'cannot-hide-core')).toBeDefined();
  });

  test('findCommandInSummary works across all tiers', () => {
    const s = buildSurfaceSummary(EMPTY);
    const view = findCommandInSummary(s, 'doctor');
    expect(view).toBeDefined();
    expect(view!.tier).toBe(CommandTier.Core);
  });

  test('hidden extended command stays callable but invisible-in-help', () => {
    const s = buildSurfaceSummary({
      ...EMPTY,
      surfaceConfig: { hidden: ['inspect'] },
    });
    const view = findCommandInSummary(s, 'inspect');
    expect(view).toBeDefined();
    expect(view!.callable).toBe(true);
    expect(view!.visibleInHelp).toBe(false);
    expect(view!.hidden).toBe(true);
  });
});
