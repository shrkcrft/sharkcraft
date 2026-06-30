import { describe, expect, test } from 'bun:test';
import { SharkCraftConfigSchema } from '../config-schema.ts';
import {
  PolicyRuleSchema,
  RegistryDeclarationSchema,
  ReusePrimitiveSchema,
  WiringRuleSchema,
} from '@shrkcrft/config';

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

  test('accepts an arrayProperty source (no capture group required)', () => {
    const r = SharkCraftConfigSchema.safeParse({
      wiringRules: [
        {
          id: 'w',
          declared: { files: ['src/**/*.ts'], pattern: '([a-z]+)' },
          registered: { files: ['reg/**/*.ts'], arrayProperty: 'HANDLERS' },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  test('rejects a source that sets both pattern and arrayProperty', () => {
    const r = SharkCraftConfigSchema.safeParse({
      wiringRules: [
        {
          id: 'w',
          declared: { files: ['src/**/*.ts'], pattern: '([a-z]+)', arrayProperty: 'X' },
          registered: { files: ['reg/**/*.ts'], pattern: '([a-z]+)' },
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes('exactly one'))).toBe(true);
  });

  test('rejects a source that sets neither pattern nor arrayProperty', () => {
    const r = SharkCraftConfigSchema.safeParse({
      wiringRules: [
        {
          id: 'w',
          declared: { files: ['src/**/*.ts'] },
          registered: { files: ['reg/**/*.ts'], pattern: '([a-z]+)' },
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message.includes('exactly one'))).toBe(true);
  });

  test('accepts a registered union array of sources', () => {
    const r = SharkCraftConfigSchema.safeParse({
      wiringRules: [
        {
          id: 'w',
          declared: { files: ['src/**/*.ts'], pattern: '([a-z]+)' },
          registered: [
            { files: ['reg-a/**/*.ts'], pattern: '([a-z]+)' },
            { files: ['reg-b/**/*.ts'], arrayProperty: 'EXTRA' },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  test('accepts groupBy + mode + directional hints', () => {
    const r = SharkCraftConfigSchema.safeParse({
      wiringRules: [
        {
          id: 'w',
          groupBy: 'package',
          mode: 'parity',
          declared: { files: ['src/**/*.ts'], pattern: '([a-z]+)' },
          registered: { files: ['reg/**/*.ts'], pattern: '([a-z]+)' },
          hintDeclaredMissing: 'wire it up',
          hintRegisteredMissing: 'remove or use it',
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  test('rejects an unknown groupBy / mode value', () => {
    const badGroup = SharkCraftConfigSchema.safeParse({
      wiringRules: [
        {
          id: 'w',
          groupBy: 'module',
          declared: { files: ['src/**/*.ts'], pattern: '([a-z]+)' },
          registered: { files: ['reg/**/*.ts'], pattern: '([a-z]+)' },
        },
      ],
    });
    expect(badGroup.success).toBe(false);
    const badMode = SharkCraftConfigSchema.safeParse({
      wiringRules: [
        {
          id: 'w',
          mode: 'superset',
          declared: { files: ['src/**/*.ts'], pattern: '([a-z]+)' },
          registered: { files: ['reg/**/*.ts'], pattern: '([a-z]+)' },
        },
      ],
    });
    expect(badMode.success).toBe(false);
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

describe('per-plane schemas are exported from @shrkcrft/config', () => {
  // The inspector's resolveProjectConfig seam validates each pack-contributed
  // element with these same schemas, so they must be importable package-side.
  test('all four plane schemas are importable and validate a single element', () => {
    expect(typeof WiringRuleSchema.safeParse).toBe('function');
    expect(typeof RegistryDeclarationSchema.safeParse).toBe('function');
    expect(typeof PolicyRuleSchema.safeParse).toBe('function');
    expect(typeof ReusePrimitiveSchema.safeParse).toBe('function');

    expect(
      WiringRuleSchema.safeParse({
        id: 'w',
        declared: { files: ['src/**/*.ts'], pattern: '([a-z]+)' },
        registered: { files: ['reg/**/*.ts'], pattern: '([a-z]+)' },
      }).success,
    ).toBe(true);
    expect(
      RegistryDeclarationSchema.safeParse({
        name: 'commands',
        source: { files: ['src/**/*.ts'], pattern: '([a-z]+)' },
      }).success,
    ).toBe(true);
    expect(
      PolicyRuleSchema.safeParse({ id: 'p', surface: 'template', pattern: '<button', message: 'm' })
        .success,
    ).toBe(true);
    expect(ReusePrimitiveSchema.safeParse({ symbol: 'Button', roles: ['button'] }).success).toBe(true);
  });

  test('a single wiring element with no capture group is rejected (same superRefine)', () => {
    const r = WiringRuleSchema.safeParse({
      id: 'w',
      declared: { files: ['src/**/*.ts'], pattern: 'nocapture' },
      registered: { files: ['reg/**/*.ts'], pattern: '([a-z]+)' },
    });
    expect(r.success).toBe(false);
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
