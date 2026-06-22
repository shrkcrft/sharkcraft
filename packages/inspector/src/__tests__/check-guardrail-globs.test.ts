import { describe, expect, test } from 'bun:test';
import { checkGuardrailGlobs } from '../check-guardrail-globs.ts';

describe('checkGuardrailGlobs (allow-list)', () => {
  test('allows a target covered by a glob', () => {
    const r = checkGuardrailGlobs(['packages/x/src/index.ts'], ['packages/*/src/**']);
    expect(r.ok).toBe(true);
    expect(r.refused).toHaveLength(0);
  });

  test('refuses a target covered by NO glob', () => {
    const r = checkGuardrailGlobs(['packages/x/src/index.ts', 'sharkcraft.config.ts'], ['packages/*/src/**']);
    expect(r.ok).toBe(false);
    expect(r.refused).toEqual(['sharkcraft.config.ts']);
    expect(r.allowed).toEqual(['packages/x/src/index.ts']);
  });

  test('an empty glob list refuses everything (no blast-radius fence)', () => {
    const r = checkGuardrailGlobs(['a.ts'], []);
    expect(r.ok).toBe(false);
    expect(r.refused).toEqual(['a.ts']);
  });

  test('is case-sensitive: `src/**` does not also grant `SRC/...`', () => {
    const r = checkGuardrailGlobs(['SRC/secret.ts', 'src/ok.ts'], ['src/**']);
    expect(r.refused).toEqual(['SRC/secret.ts']);
    expect(r.allowed).toEqual(['src/ok.ts']);
  });

  test('a `**` glob with a suffix scopes to a directory + extension', () => {
    const r = checkGuardrailGlobs(
      ['src/index.ts', 'src/deep/nested/barrel.ts', 'test/index.ts'],
      ['src/**'],
    );
    expect(r.allowed).toEqual(['src/index.ts', 'src/deep/nested/barrel.ts']);
    expect(r.refused).toEqual(['test/index.ts']);
  });
});
