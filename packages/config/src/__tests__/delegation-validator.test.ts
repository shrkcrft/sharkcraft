import { describe, expect, test } from 'bun:test';
import { validateConfig } from '../config-validator.ts';
import type { ISharkCraftConfig } from '../sharkcraft-config.ts';

const recipe = {
  id: 'add-barrel-export',
  guardrailGlobs: ['packages/*/src/**'],
  allowedOps: ['export'],
  verificationIds: ['barrel-tsc'],
};

describe('validateConfig — delegation recipes', () => {
  test('passes when every verificationId resolves to a verificationCommand', () => {
    const config: ISharkCraftConfig = {
      verificationCommands: [{ id: 'barrel-tsc', command: 'tsc --noEmit' }],
      delegation: { recipes: [recipe] },
    };
    const r = validateConfig(config);
    expect(r.valid).toBe(true);
  });

  test('errors on a dangling verificationId (would silently un-gate the edit)', () => {
    const config: ISharkCraftConfig = {
      verificationCommands: [{ id: 'other', command: 'true' }],
      delegation: { recipes: [recipe] },
    };
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field.includes('verificationIds') && i.message.includes('barrel-tsc'))).toBe(true);
  });

  test('errors when a recipe declares no guardrail globs', () => {
    const config: ISharkCraftConfig = {
      verificationCommands: [{ id: 'barrel-tsc', command: 'tsc' }],
      delegation: { recipes: [{ ...recipe, guardrailGlobs: [] }] },
    };
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field.includes('guardrailGlobs'))).toBe(true);
  });

  test('errors when a recipe declares no verificationIds (would apply unverified)', () => {
    const config: ISharkCraftConfig = {
      verificationCommands: [{ id: 'barrel-tsc', command: 'tsc' }],
      delegation: { recipes: [{ ...recipe, verificationIds: [] }] },
    };
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field.includes('verificationIds') && i.message.includes('unverified'))).toBe(true);
  });

  test('errors on a duplicate recipe id', () => {
    const config: ISharkCraftConfig = {
      verificationCommands: [{ id: 'barrel-tsc', command: 'tsc' }],
      delegation: { recipes: [recipe, recipe] },
    };
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.message.includes('duplicate'))).toBe(true);
  });
});

describe('validateConfig — analysis recipes', () => {
  const analysis = {
    id: 'arch-risk-review',
    mode: 'analysis' as const,
    groundedOn: 'task-risk' as const,
  };

  test('a well-formed analysis recipe validates with no verificationCommands needed', () => {
    const config: ISharkCraftConfig = { delegation: { recipes: [analysis] } };
    const r = validateConfig(config);
    expect(r.valid).toBe(true);
  });

  test('errors when an analysis recipe omits groundedOn', () => {
    const config = { delegation: { recipes: [{ id: 'x', mode: 'analysis' }] } } as unknown as ISharkCraftConfig;
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field.includes('groundedOn') && i.message.includes('must declare'))).toBe(true);
  });

  test('errors on an unknown groundedOn report', () => {
    const config = {
      delegation: { recipes: [{ id: 'x', mode: 'analysis', groundedOn: 'bogus-report' }] },
    } as unknown as ISharkCraftConfig;
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field.includes('groundedOn') && i.message.includes('unknown'))).toBe(true);
  });

  test('errors when an analysis recipe declares a write fence (read-only invariant)', () => {
    const config = {
      delegation: { recipes: [{ ...analysis, allowedOps: ['export'] }] },
    } as unknown as ISharkCraftConfig;
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field.includes('allowedOps') && i.message.includes('read-only'))).toBe(true);
  });

  test('an analysis recipe does NOT trigger the patch-mode verificationId checks', () => {
    // No verificationCommands, no verificationIds — a patch recipe would error here;
    // an analysis recipe must not, because it never writes.
    const config: ISharkCraftConfig = { delegation: { recipes: [analysis] } };
    const r = validateConfig(config);
    expect(r.issues.some((i) => i.message.includes('unverified'))).toBe(false);
    expect(r.issues.some((i) => i.field.includes('verificationIds'))).toBe(false);
  });

  test('a valid analysis recipe with a bounded query loop validates', () => {
    const config: ISharkCraftConfig = {
      delegation: { recipes: [{ ...analysis, allowedQueries: ['coverage', 'test-impact', 'graph-callers', 'graph-context'], maxQueryRounds: 2 }] },
    };
    expect(validateConfig(config).valid).toBe(true);
  });

  test('errors on an unknown allowedQueries entry', () => {
    const config = {
      delegation: { recipes: [{ ...analysis, allowedQueries: ['coverage', 'bogus-query'] }] },
    } as unknown as ISharkCraftConfig;
    const r = validateConfig(config);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field.includes('allowedQueries') && i.message.includes('bogus-query'))).toBe(true);
  });

  test('escalateTo must reference an existing patch recipe', () => {
    const patch = { id: 'scaffold-test-stub', guardrailGlobs: ['**/*.test.ts'], allowedOps: ['create'], verificationIds: ['t'] };
    const okConfig: ISharkCraftConfig = {
      verificationCommands: [{ id: 't', command: 'true' }],
      delegation: { recipes: [{ ...analysis, escalateTo: 'scaffold-test-stub' }, patch] },
    };
    expect(validateConfig(okConfig).valid).toBe(true);

    // Points at a non-existent recipe → error.
    const missing = validateConfig({ delegation: { recipes: [{ ...analysis, escalateTo: 'nope' }] } });
    expect(missing.valid).toBe(false);
    expect(missing.issues.some((i) => i.field.includes('escalateTo'))).toBe(true);

    // Points at an ANALYSIS recipe (not a patch) → error.
    const analysisTarget = validateConfig({
      delegation: {
        recipes: [
          { ...analysis, id: 'a', escalateTo: 'b' },
          { id: 'b', mode: 'analysis', groundedOn: 'task-risk' },
        ],
      },
    });
    expect(analysisTarget.valid).toBe(false);
    expect(analysisTarget.issues.some((i) => i.field.includes('escalateTo'))).toBe(true);
  });
});
