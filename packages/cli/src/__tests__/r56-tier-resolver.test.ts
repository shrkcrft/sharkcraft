/**
 * tier resolver: mechanical derivation of CommandTier across
 * bootstrap / spine / pack / override / hidden / default sources.
 *
 * Locks in: bootstrap commands always Core, spine references always
 * Core, pack contributions default Experimental, surface.enabled[]
 * promotes Experimental → Extended, surface.hidden[] only flips
 * Extended visibility (never gates callability), and the catalog
 * `tier:` override cannot demote Core.
 */
import { describe, expect, test } from 'bun:test';
import {
  COMMAND_CATALOG,
  CommandTier,
} from '../commands/command-catalog.ts';
import { BOOTSTRAP_COMMANDS, resolveTier, TierSource } from '../surface/tier.ts';
import type { ITierResolverContext } from '../surface/tier.ts';

const EMPTY_CONTEXT: ITierResolverContext = {
  spineCommands: new Set(),
  packContributions: new Map(),
  surfaceConfig: undefined,
};

function findEntry(name: string) {
  const entry = COMMAND_CATALOG.find((e) => e.command === name);
  if (!entry) throw new Error(`No catalog entry for ${name}`);
  return entry;
}

describe('tier resolver', () => {
  test('bootstrap commands always resolve to Core', () => {
    for (const name of BOOTSTRAP_COMMANDS) {
      const entry = COMMAND_CATALOG.find((e) => e.command === name);
      if (!entry) continue; // meta-flags like --about
      const r = resolveTier(entry, EMPTY_CONTEXT);
      expect(r.tier).toBe(CommandTier.Core);
      expect(r.source).toBe(TierSource.Bootstrap);
    }
  });

  test('spine pipeline references resolve to Core (overrides default)', () => {
    const entry = findEntry('context');
    const r = resolveTier(entry, {
      ...EMPTY_CONTEXT,
      spineCommands: new Set(['context']),
    });
    expect(r.tier).toBe(CommandTier.Core);
    expect(r.source).toBe(TierSource.Spine);
  });

  test('pack contributions default to Experimental', () => {
    const entry = findEntry('apply');
    const r = resolveTier(entry, {
      ...EMPTY_CONTEXT,
      packContributions: new Map([['apply', 'fake-pack']]),
    });
    expect(r.tier).toBe(CommandTier.Experimental);
    expect(r.source).toBe(TierSource.PackContribution);
    expect(r.detail).toContain('fake-pack');
  });

  test('surface.enabled promotes pack contribution to Extended', () => {
    const entry = findEntry('apply');
    const r = resolveTier(entry, {
      ...EMPTY_CONTEXT,
      packContributions: new Map([['apply', 'fake-pack']]),
      surfaceConfig: { enabled: ['apply'] },
    });
    expect(r.tier).toBe(CommandTier.Extended);
    expect(r.source).toBe(TierSource.PackContribution);
    expect(r.configApplied).toBe(true);
  });

  test('default tier for a normal catalog entry is Extended', () => {
    const entry = findEntry('apply');
    const r = resolveTier(entry, EMPTY_CONTEXT);
    expect(r.tier).toBe(CommandTier.Extended);
    expect(r.source).toBe(TierSource.Default);
  });

  test('explicit catalog tier=Experimental gates on surface.enabled', () => {
    const entry = { ...findEntry('apply'), tier: CommandTier.Experimental };
    const r1 = resolveTier(entry, EMPTY_CONTEXT);
    expect(r1.tier).toBe(CommandTier.Experimental);
    expect(r1.source).toBe(TierSource.Override);

    const r2 = resolveTier(entry, {
      ...EMPTY_CONTEXT,
      surfaceConfig: { enabled: ['apply'] },
    });
    expect(r2.tier).toBe(CommandTier.Extended);
    expect(r2.configApplied).toBe(true);
  });

  test('catalog tier=Extended override is honored', () => {
    const entry = { ...findEntry('apply'), tier: CommandTier.Extended };
    const r = resolveTier(entry, EMPTY_CONTEXT);
    expect(r.tier).toBe(CommandTier.Extended);
    expect(r.source).toBe(TierSource.Override);
  });

  test('bootstrap wins over catalog tier override', () => {
    const entry = { ...findEntry('doctor'), tier: CommandTier.Experimental };
    const r = resolveTier(entry, EMPTY_CONTEXT);
    expect(r.tier).toBe(CommandTier.Core);
    expect(r.source).toBe(TierSource.Bootstrap);
  });

  test('spine wins over catalog tier override', () => {
    const entry = { ...findEntry('apply'), tier: CommandTier.Experimental };
    const r = resolveTier(entry, {
      ...EMPTY_CONTEXT,
      spineCommands: new Set(['apply']),
    });
    expect(r.tier).toBe(CommandTier.Core);
    expect(r.source).toBe(TierSource.Spine);
  });

  test('showInDefaultHelp=false in catalog → Experimental (gated by enabled)', () => {
    const entry = { ...findEntry('apply'), showInDefaultHelp: false };
    const r = resolveTier(entry, EMPTY_CONTEXT);
    expect(r.tier).toBe(CommandTier.Experimental);
    expect(r.source).toBe(TierSource.Hidden);

    const r2 = resolveTier(entry, {
      ...EMPTY_CONTEXT,
      surfaceConfig: { enabled: ['apply'] },
    });
    expect(r2.tier).toBe(CommandTier.Extended);
  });
});
