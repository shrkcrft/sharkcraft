import { describe, expect, test } from 'bun:test';
import { samplePathMatchesConvention } from '../template-drift.ts';

/**
 * Regression guard for the path-convention verifier. It used to read a
 * non-existent `pattern` field on path conventions (the real field is
 * `metadata.path`), which skipped every convention and flagged ~140
 * sample paths as "does not match any registered path convention". The
 * matcher below is what replaced that broken substring heuristic.
 */
describe('samplePathMatchesConvention', () => {
  test('a file under the convention directory matches', () => {
    expect(
      samplePathMatchesConvention(
        'libs/nge/cms-ui/cms-ui-foo-api/src/index.ts',
        'libs/nge/cms-ui',
      ),
    ).toBe(true);
  });

  test('the convention path itself matches (file-valued convention)', () => {
    expect(
      samplePathMatchesConvention('scripts/check-css-tokens.sh', 'scripts/check-css-tokens.sh'),
    ).toBe(true);
  });

  test('a sibling with a shared prefix does NOT match (trailing-slash guard)', () => {
    expect(samplePathMatchesConvention('libs/nge/core-extra/x.ts', 'libs/nge/core')).toBe(false);
  });

  test('an unrelated path does not match', () => {
    expect(samplePathMatchesConvention('sample/Isample.ts', 'libs/nge/core')).toBe(false);
  });
});
