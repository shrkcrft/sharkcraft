import { describe, expect, test } from 'bun:test';
import { SharkCraftConfigSchema } from '../config-schema.ts';

function rule(declaredPattern: string, registeredPattern = "register\\('([^']+)'\\)", flags?: string) {
  return {
    wiringRules: [
      {
        id: 'w',
        declared: { files: ['src/**/*.ts'], pattern: declaredPattern, ...(flags ? { flags } : {}) },
        registered: { files: ['reg/**/*.ts'], pattern: registeredPattern },
      },
    ],
  };
}

describe('SharkCraftConfigSchema — wiringRules validation', () => {
  test('accepts a well-formed wiring rule', () => {
    expect(SharkCraftConfigSchema.safeParse(rule("use\\('([^']+)'\\)")).success).toBe(true);
  });

  test('rejects an uncompilable pattern with a clear path', () => {
    const r = SharkCraftConfigSchema.safeParse(rule('([A-Z'));
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.').includes('pattern'));
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('invalid regular expression');
    }
  });

  test('rejects a pattern with no capture group', () => {
    const r = SharkCraftConfigSchema.safeParse(rule('usesomething'));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('capture group'))).toBe(true);
    }
  });

  test('rejects bad regex flags', () => {
    const r = SharkCraftConfigSchema.safeParse(rule("use\\('([^']+)'\\)", "register\\('([^']+)'\\)", 'x'));
    expect(r.success).toBe(false);
  });

  test('rejects an unknown key in a wiring source (strict)', () => {
    const bad = {
      wiringRules: [
        {
          id: 'w',
          declared: { files: ['src/**/*.ts'], pattern: '([a-z])', bogus: true },
          registered: { files: ['reg/**/*.ts'], pattern: '([a-z])' },
        },
      ],
    };
    expect(SharkCraftConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe('SharkCraftConfigSchema — policyRules validation', () => {
  test('accepts a well-formed policy rule', () => {
    const r = SharkCraftConfigSchema.safeParse({
      policyRules: [{ id: 'p', surface: 'template', pattern: '<button', message: 'no raw button' }],
    });
    expect(r.success).toBe(true);
  });

  test('rejects an unknown surface', () => {
    const r = SharkCraftConfigSchema.safeParse({
      policyRules: [{ id: 'p', surface: 'markup', pattern: '<button', message: 'm' }],
    });
    expect(r.success).toBe(false);
  });

  test('rejects an uncompilable pattern', () => {
    const r = SharkCraftConfigSchema.safeParse({
      policyRules: [{ id: 'p', surface: 'ts', pattern: '([A-Z', message: 'm' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes('invalid regular expression'))).toBe(true);
  });

  test('policy patterns do NOT require a capture group', () => {
    const r = SharkCraftConfigSchema.safeParse({
      policyRules: [{ id: 'p', surface: 'template', pattern: '<button', message: 'm' }],
    });
    expect(r.success).toBe(true);
  });
});

describe('SharkCraftConfigSchema — reusePrimitives validation', () => {
  test('accepts a well-formed primitive', () => {
    const r = SharkCraftConfigSchema.safeParse({
      reusePrimitives: [{ symbol: 'Button', roles: ['button'], importPath: '@scope/ui' }],
    });
    expect(r.success).toBe(true);
  });

  test('requires symbol + roles', () => {
    expect(SharkCraftConfigSchema.safeParse({ reusePrimitives: [{ roles: ['x'] }] }).success).toBe(false);
    expect(SharkCraftConfigSchema.safeParse({ reusePrimitives: [{ symbol: 'X' }] }).success).toBe(false);
  });

  test('rejects an unknown key (strict)', () => {
    const r = SharkCraftConfigSchema.safeParse({
      reusePrimitives: [{ symbol: 'X', roles: ['x'], bogus: 1 }],
    });
    expect(r.success).toBe(false);
  });
});
