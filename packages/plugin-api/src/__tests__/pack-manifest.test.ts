import { describe, expect, test } from 'bun:test';
import {
  CONTRIBUTION_FILE_KEYS,
  definePackManifest,
  validatePackManifest,
} from '../pack-manifest.ts';

describe('validatePackManifest', () => {
  test('accepts a minimal valid manifest', () => {
    const r = validatePackManifest({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@x/y', version: '0.1.0' },
      contributions: {},
    });
    expect(r.valid).toBe(true);
    expect(r.issues.length).toBe(0);
  });

  test('rejects wrong schema marker', () => {
    const r = validatePackManifest({
      schema: 'wrong/v0',
      info: { name: '@x/y', version: '0.1.0' },
      contributions: {},
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'schema')).toBe(true);
  });

  test('rejects missing info', () => {
    const r = validatePackManifest({
      schema: 'sharkcraft.pack/v1',
      contributions: {},
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'info')).toBe(true);
  });

  test('rejects non-array contributions', () => {
    const r = validatePackManifest({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@x/y', version: '0.1.0' },
      contributions: { knowledgeFiles: 'not-an-array' as never },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'contributions.knowledgeFiles')).toBe(true);
  });

  // P4 — the four "cross-file invariant as DATA" plane slots are canonical
  // contribution kinds (verified/counted/scored), not future no-ops.
  const PLANE_SLOTS = [
    'wiringRuleFiles',
    'registryFiles',
    'policyRuleFiles',
    'reusePrimitiveFiles',
  ] as const;

  test('CONTRIBUTION_FILE_KEYS includes the four data-plane slots', () => {
    for (const slot of PLANE_SLOTS) {
      expect(CONTRIBUTION_FILE_KEYS).toContain(slot);
    }
  });

  test('rejects a non-string-array for each new data-plane slot', () => {
    for (const slot of PLANE_SLOTS) {
      const r = validatePackManifest({
        schema: 'sharkcraft.pack/v1',
        info: { name: '@x/y', version: '0.1.0' },
        contributions: { [slot]: 'not-an-array' as never },
      });
      expect(r.valid).toBe(false);
      expect(r.issues.some((i) => i.field === `contributions.${slot}`)).toBe(true);
    }
  });

  test('accepts string-array values for the new data-plane slots', () => {
    const r = validatePackManifest({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@x/y', version: '0.1.0' },
      contributions: {
        wiringRuleFiles: ['./wiring.ts'],
        registryFiles: ['./registries.ts'],
        policyRuleFiles: ['./policy.ts'],
        reusePrimitiveFiles: ['./reuse.ts'],
      },
    });
    expect(r.valid).toBe(true);
    expect(r.issues.length).toBe(0);
  });

  test('definePackManifest returns the manifest as-is', () => {
    const m = definePackManifest({
      schema: 'sharkcraft.pack/v1',
      info: { name: '@a/b', version: '1.0.0' },
      contributions: { templateFiles: ['./t.ts'] },
    });
    expect(m.info.name).toBe('@a/b');
  });
});
