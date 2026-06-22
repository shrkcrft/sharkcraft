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
